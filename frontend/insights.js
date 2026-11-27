/*
 * Viewtopsy insights beyond "where did chat spike":
 *  - what kind of spike it was (organic, prompted, alert, copypasta)
 *  - quiet stretches where chat died
 *  - engagement per segment (game chapters or time blocks)
 *  - which moments viewers already clipped, and which nobody did
 *  - marker files for DaVinci Resolve and Premiere Pro
 *  - how long chat takes to react, measured from AI cause times
 * Pure functions: browser (window.ViewtopsyInsights) and Node.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.ViewtopsyInsights = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function clock(seconds) {
    const s = Math.max(0, Math.floor(seconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = String(s % 60).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
  }

  function between(messages, from, to) {
    return messages.filter((m) => m.timestamp >= from && m.timestamp < to);
  }

  // ---------------------------------------------------------------------------
  // Spike types
  // ---------------------------------------------------------------------------

  const KINDS = {
    organic: { label: "Organic reaction", hint: "Chat reacted to something on its own." },
    prompted: { label: "Prompted", hint: "Chat was answering a question or voting." },
    alert: { label: "Alert-driven", hint: "Driven by subs, gifts, donations or a raid." },
    copypasta: { label: "Copypasta / spam wave", hint: "Most of chat pasted the same message." },
    greeting: { label: "Hellos / goodbyes", hint: "Chat greeting the stream or saying goodbye." },
  };

  const normalize = (text) => String(text).toLowerCase().replace(/\s+/g, " ").trim();

  /**
   * Labels what kind of spike this was.
   * @param messages messages inside the moment
   * @param profile ViewtopsyReactions.profile(messages)
   */
  function momentKind(messages, profile) {
    const counts = new Map();
    for (const m of messages) {
      const key = normalize(m.text);
      if (key.length >= 15) counts.set(key, (counts.get(key) || 0) + 1);
    }
    const top = [...counts.values()].sort((a, b) => b - a)[0] || 0;
    if (top >= 5 && top / Math.max(1, messages.length) >= 0.35) return { id: "copypasta", ...KINDS.copypasta };

    const read = Math.round((profile?.readShare || 0) * messages.length);
    const share = (id) => profile?.types.find((t) => t.id === id)?.share || 0;
    if (read >= 5) {
      if (share("voting") >= 0.4) return { id: "prompted", ...KINDS.prompted };
      if (share("support") >= 0.4) return { id: "alert", ...KINDS.alert };
      if (share("greeting") >= 0.5) return { id: "greeting", ...KINDS.greeting };
    }
    return { id: "organic", ...KINDS.organic };
  }

  // ---------------------------------------------------------------------------
  // Quiet stretches (dead zones)
  // ---------------------------------------------------------------------------

  /**
   * Finds stretches where chat stayed well below its normal pace.
   * Uses a 2-minute rolling average so one slow window doesn't count.
   * @param result output of ViewtopsyAnalysis.findMoments
   * @returns [{start, end, duration, pace, nearEdge, messageCount, samples}]
   *   pace: chat rate as a share of normal (0.25 = a quarter of normal)
   */
  function findQuietStretches(messages, result, { windowSeconds = 15, threshold = 0.4, minSeconds = 180, limit = 8 } = {}) {
    const { timeline, timelineStart, mean } = result;
    if (!timeline.length || !mean) return [];
    const span = Math.max(1, Math.round(120 / windowSeconds));
    const smooth = timeline.map((_, i) => {
      const from = Math.max(0, i - Math.floor(span / 2));
      const slice = timeline.slice(from, from + span);
      return slice.reduce((a, b) => a + b, 0) / slice.length;
    });

    const runs = [];
    for (let i = 0; i < smooth.length; i += 1) {
      if (smooth[i] >= threshold * mean) continue;
      const last = runs[runs.length - 1];
      if (last && last.end === i - 1) last.end = i;
      else runs.push({ start: i, end: i });
    }

    const streamStart = timelineStart;
    const streamEnd = timelineStart + timeline.length * windowSeconds;
    return runs
      .map((run) => {
        const start = timelineStart + run.start * windowSeconds;
        const end = timelineStart + (run.end + 1) * windowSeconds;
        const counts = timeline.slice(run.start, run.end + 1);
        const pace = counts.reduce((a, b) => a + b, 0) / counts.length / mean;
        const inside = between(messages, start, end);
        return {
          start,
          end,
          duration: end - start,
          pace: Number(pace.toFixed(2)),
          // The first and last few minutes are often quiet for ordinary reasons.
          nearEdge: start - streamStart < 180 || streamEnd - end < 180,
          messageCount: inside.length,
          samples: inside.filter((_, i) => i % Math.max(1, Math.ceil(inside.length / 6)) === 0).slice(0, 6).map((m) => ({ text: m.text, author: m.author })),
          score: (end - start) * (1 - pace),
        };
      })
      .filter((z) => z.duration >= minSeconds)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((z, i) => ({ ...z, rank: i + 1 }));
  }

  // ---------------------------------------------------------------------------
  // Segments
  // ---------------------------------------------------------------------------

  /**
   * Engagement per part of the stream. Uses the export's chapters (game
   * changes) when there are at least two in range, otherwise equal time blocks.
   * @param chapters [{start, end, title}] in stream seconds
   */
  function segmentScores(messages, result, { chapters = [], quiet = [] } = {}) {
    if (!messages.length) return { basis: "none", segments: [] };
    const first = messages[0].timestamp;
    const last = messages[messages.length - 1].timestamp;
    const overall = messages.length / Math.max(60, last - first);

    let basis = "chapters";
    let parts = chapters
      .map((c) => ({ start: Math.max(c.start, first), end: Math.min(c.end, last + 1), title: c.title || "Untitled" }))
      .filter((c) => c.end - c.start >= 60);
    if (parts.length < 2) {
      basis = "time";
      const range = last - first;
      const block = [300, 600, 900, 1800, 3600].find((b) => range / b <= 8) || 7200;
      parts = [];
      for (let t = Math.floor(first / block) * block; t <= last; t += block) {
        const start = Math.max(t, first);
        const end = Math.min(t + block, last + 1);
        if (end - start >= 60) parts.push({ start, end, title: `${clock(start)}–${clock(end)}` });
      }
    }

    const segments = parts.map((p) => {
      const inside = between(messages, p.start, p.end);
      const rate = inside.length / Math.max(60, p.end - p.start);
      const moments = result.moments.filter((m) => m.peakTime >= p.start && m.peakTime < p.end);
      const quietSeconds = quiet.reduce((sum, z) => sum + Math.max(0, Math.min(z.end, p.end) - Math.max(z.start, p.start)), 0);
      return {
        ...p,
        duration: p.end - p.start,
        messageCount: inside.length,
        perMinute: Number((rate * 60).toFixed(1)),
        relative: Number((rate / overall).toFixed(2)),
        chatters: new Set(inside.map((m) => m.author).filter(Boolean)).size,
        momentCount: moments.length,
        topMoment: moments.sort((a, b) => a.rank - b.rank)[0]?.rank ?? null,
        quietSeconds,
      };
    });
    return { basis, segments };
  }

  // ---------------------------------------------------------------------------
  // Existing clips
  // ---------------------------------------------------------------------------

  /**
   * Reads a clips file: Viewtopsy's `stream-moments fetch-clips` output, the
   * raw Twitch API response ({data: [...]}) or a plain array.
   * Keeps only clips with a known position in the VOD.
   */
  function parseClips(raw, videoId = "") {
    const payload = typeof raw === "string" ? JSON.parse(raw) : raw;
    const rows = Array.isArray(payload) ? payload : payload.clips || payload.data || [];
    return rows
      .map((c) => ({
        id: String(c.id || c.slug || ""),
        title: String(c.title || ""),
        url: String(c.url || (c.id ? `https://clips.twitch.tv/${c.id}` : "")),
        views: Number(c.view_count ?? c.views ?? 0),
        start: Number(c.vod_offset ?? c.vodOffset ?? c.start),
        duration: Number(c.duration ?? 30),
        creator: String(c.creator_name || c.creator || ""),
        videoId: String(c.video_id || c.videoId || ""),
      }))
      .filter((c) => Number.isFinite(c.start) && (!videoId || !c.videoId || c.videoId === String(videoId)))
      .sort((a, b) => a.start - b.start);
  }

  /**
   * Matches clips to moments. A clip counts for a moment if it overlaps the
   * stretch from 30s before chat started rising to the end of the spike.
   * @returns {byMoment: Map<windowStart, clip[]>, unmatched: clip[]}
   */
  function matchClips(moments, clips) {
    const byMoment = new Map();
    const used = new Set();
    for (const m of moments) {
      const from = (m.onsetTime ?? m.windowStart) - 30;
      const to = m.windowEnd + 10;
      const hits = clips.filter((c) => c.start < to && c.start + c.duration > from);
      hits.forEach((c) => used.add(c));
      byMoment.set(m.windowStart, hits.sort((a, b) => b.views - a.views));
    }
    return { byMoment, unmatched: clips.filter((c) => !used.has(c)).sort((a, b) => b.views - a.views) };
  }

  // ---------------------------------------------------------------------------
  // Editor marker exports
  // ---------------------------------------------------------------------------

  function timecode(seconds, fps, startHour = 0) {
    const totalFrames = Math.max(0, Math.round(seconds * fps)) + startHour * 3600 * fps;
    const f = totalFrames % fps;
    const s = Math.floor(totalFrames / fps);
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}:${pad(f)}`;
  }

  function markerName(m) {
    return (m.note || m.ai?.title || m.keywords?.slice(0, 3).join(" / ") || "Moment").replace(/[|\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  }

  function markerComment(m) {
    return [
      `#${m.rank} · ${m.intensity}x chat · ${m.reaction || ""}${m.kind ? ` · ${m.kind.label}` : ""}`,
      m.ai?.whatHappened || "",
      m.clips && m.clips.length === 0 ? "Not clipped yet" : "",
    ].filter(Boolean).join(" — ").replace(/[|\r\n]+/g, " ");
  }

  /**
   * DaVinci Resolve timeline markers (Timeline > Import > Timeline Markers from EDL).
   * Times are relative to the video file: stream time minus videoOffset.
   * Resolve timelines start at 01:00:00:00 by default.
   */
  function toResolveEdl(moments, { videoOffset = 0, fps = 30, title = "Viewtopsy markers", startHour = 1 } = {}) {
    const lines = [`TITLE: ${title.replace(/[\r\n]+/g, " ")}`, "FCM: NON-DROP FRAME", ""];
    const colors = { organic: "ResolveColorRed", prompted: "ResolveColorBlue", alert: "ResolveColorYellow", copypasta: "ResolveColorPurple", greeting: "ResolveColorCyan" };
    [...moments]
      .filter((m) => m.timestamp - videoOffset >= 0)
      .sort((a, b) => a.timestamp - b.timestamp)
      .forEach((m, i) => {
        const t = m.timestamp - videoOffset;
        const tcIn = timecode(t, fps, startHour);
        const tcOut = timecode(t + 1 / fps, fps, startHour);
        const color = colors[m.kind?.id] || "ResolveColorGreen";
        const length = Math.max(1, Math.round((m.windowEnd - m.timestamp) * fps));
        lines.push(`${String(i + 1).padStart(3, "0")}  001      V     C        ${tcIn} ${tcOut} ${tcIn} ${tcOut}  `);
        lines.push(` |C:${color} |M:${markerName(m)} |D:${length}`);
        lines.push("");
      });
    return lines.join("\n");
  }

  const xml = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  /**
   * Final Cut Pro 7 XML with a sequence holding the video and one marker per
   * moment. Premiere Pro (File > Import) and Resolve both read it; they ask you
   * to locate the video file the first time.
   */
  function toPremiereXml(moments, { videoOffset = 0, fps = 30, title = "Viewtopsy", videoName = "video.mp4", videoDuration = 0 } = {}) {
    const frames = (s) => Math.max(0, Math.round(s * fps));
    const duration = frames(videoDuration || Math.max(...moments.map((m) => m.windowEnd - videoOffset), 60));
    const rate = `<rate><timebase>${fps}</timebase><ntsc>FALSE</ntsc></rate>`;
    const markers = [...moments]
      .filter((m) => m.timestamp - videoOffset >= 0)
      .sort((a, b) => a.timestamp - b.timestamp)
      .map((m) => [
        "      <marker>",
        `        <name>${xml(`#${m.rank} ${markerName(m)}`)}</name>`,
        `        <comment>${xml(markerComment(m))}</comment>`,
        `        <in>${frames(m.timestamp - videoOffset)}</in>`,
        `        <out>${frames(m.windowEnd - videoOffset)}</out>`,
        "      </marker>",
      ].join("\n"))
      .join("\n");
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="4">
  <sequence id="viewtopsy-sequence">
    <name>${xml(title)}</name>
    <duration>${duration}</duration>
    ${rate}
    <timecode>${rate}<string>00:00:00:00</string><frame>0</frame><displayformat>NDF</displayformat></timecode>
    <media>
      <video>
        <track>
          <clipitem id="clipitem-1">
            <name>${xml(videoName)}</name>
            <duration>${duration}</duration>
            ${rate}
            <start>0</start>
            <end>${duration}</end>
            <in>0</in>
            <out>${duration}</out>
            <file id="file-1">
              <name>${xml(videoName)}</name>
              <pathurl>file://localhost/${encodeURIComponent(videoName)}</pathurl>
              ${rate}
              <duration>${duration}</duration>
              <media><video/><audio/></media>
            </file>
          </clipitem>
        </track>
      </video>
    </media>
${markers}
  </sequence>
</xmeml>
`;
  }

  // ---------------------------------------------------------------------------
  // Reaction lag, measured from AI cause times
  // ---------------------------------------------------------------------------

  function parseClock(text) {
    if (typeof text !== "string") return NaN;
    const parts = text.trim().split(":").map(Number);
    if (parts.some((n) => !Number.isFinite(n))) return NaN;
    return parts.reduce((total, n) => total * 60 + n, 0);
  }

  /**
   * How long after the cause chat starts rising, from explained moments.
   * Only medium/high confidence explanations with a plausible cause time count.
   */
  function reactionLag(moments) {
    const lags = moments
      .filter((m) => m.ai && m.ai.confidence !== "low" && m.onsetTime != null)
      .map((m) => (m.onsetTime + (m.windowSeconds || 15) / 2) - parseClock(m.ai.causeTime))
      .filter((lag) => Number.isFinite(lag) && lag >= -10 && lag <= 90)
      .sort((a, b) => a - b);
    if (!lags.length) return null;
    const median = lags[Math.floor(lags.length / 2)];
    return { count: lags.length, median: Math.round(median), min: Math.round(lags[0]), max: Math.round(lags[lags.length - 1]) };
  }

  return {
    KINDS,
    momentKind,
    findQuietStretches,
    segmentScores,
    parseClips,
    matchClips,
    timecode,
    toResolveEdl,
    toPremiereXml,
    parseClock,
    reactionLag,
  };
});
