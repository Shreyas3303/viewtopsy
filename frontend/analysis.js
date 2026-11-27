/*
 * Viewtopsy analysis core.
 *
 * Pure functions with no DOM access, so the same code runs in the browser
 * (as window.ViewtopsyAnalysis) and in Node for tests (via require()).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.ViewtopsyAnalysis = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const STOP_WORDS = new Set([
    "the", "and", "that", "this", "with", "what", "for", "you", "are", "was",
    "but", "have", "just", "not", "its", "it's", "can", "his", "her", "how",
    "all", "they", "she", "him", "get", "got", "one", "now", "who", "why",
    "from", "did", "see", "way", "here", "out", "too", "our", "was", "has",
  ]);

  /** Sensitivity presets shown in the UI, mapped to a z-score threshold. */
  const SENSITIVITY = {
    low: 3.0, // only the biggest spikes
    medium: 2.0,
    high: 1.2, // more candidates, more noise
  };

  // ---------------------------------------------------------------------------
  // Parsing
  // ---------------------------------------------------------------------------

  /** Accepts seconds, "HH:MM:SS", "MM:SS" or ISO-8601 durations like "PT1H2M3S". */
  function parseTime(value) {
    if (typeof value === "number") return value;
    const text = String(value ?? "").trim();
    if (!text) return NaN;

    if (/^PT/i.test(text)) {
      const part = (unit) => {
        const match = text.match(new RegExp(`([\\d.]+)${unit}`, "i"));
        return match ? Number(match[1]) : 0;
      };
      return part("H") * 3600 + part("M") * 60 + part("S");
    }

    const pieces = text.split(":").map(Number);
    if (pieces.length === 3) return pieces[0] * 3600 + pieces[1] * 60 + pieces[2];
    if (pieces.length === 2) return pieces[0] * 60 + pieces[1];
    return Number(text);
  }

  /** Splits one CSV line, honouring quoted fields and doubled quotes. */
  function splitCsvLine(line) {
    const values = [];
    let current = "";
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const char = line[i];
      if (quoted) {
        if (char === '"' && line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else if (char === '"') {
          quoted = false;
        } else {
          current += char;
        }
      } else if (char === '"') {
        quoted = true;
      } else if (char === ",") {
        values.push(current);
        current = "";
      } else {
        current += char;
      }
    }
    values.push(current);
    return values;
  }

  function parseCsv(text) {
    const lines = text.replace(/^﻿/, "").trim().split(/\r?\n/).filter(Boolean);
    if (!lines.length) return [];
    const headers = splitCsvLine(lines.shift()).map((h) => h.trim().toLowerCase());
    return lines.map((line) => {
      const values = splitCsvLine(line);
      return Object.fromEntries(headers.map((header, i) => [header, values[i] ?? ""]));
    });
  }

  /** Turns YouTube's message "runs" (text pieces and emoji) into plain text. */
  function runsToText(message) {
    if (!message) return "";
    if (typeof message.simpleText === "string") return message.simpleText;
    return (message.runs || [])
      .map((run) => run.text ?? run.emoji?.shortcuts?.[0] ?? run.emoji?.emojiId ?? "")
      .join("");
  }

  /**
   * yt-dlp saves YouTube chat replay (`*.live_chat.json`) as one
   * replayChatItemAction per line. Expands one such line into plain rows.
   * Joins, memberships and other system items have no text and get dropped later.
   */
  function expandYtDlpRow(row) {
    const replay = row.replayChatItemAction;
    const offsetMs = Number(replay.videoOffsetTimeMsec);
    return (replay.actions || []).map((action) => {
      const item = action.addChatItemAction?.item || {};
      const renderer = item.liveChatTextMessageRenderer || item.liveChatPaidMessageRenderer || {};
      return {
        timestamp: offsetMs / 1000,
        message: runsToText(renderer.message),
        author: renderer.authorName?.simpleText ?? "",
      };
    });
  }

  /** Maps one row from any supported export format to {timestamp, text, author}. */
  function normalizeRow(row) {
    // TwitchDownloader JSON
    if (row && "content_offset_seconds" in row) {
      return {
        timestamp: Number(row.content_offset_seconds),
        text: String(row.message?.body ?? ""),
        author: String(row.commenter?.display_name ?? row.commenter?.name ?? ""),
      };
    }
    // chat-downloader (YouTube) JSON uses time_in_seconds and nested author
    if (row && "time_in_seconds" in row) {
      return {
        timestamp: Number(row.time_in_seconds),
        text: String(row.message ?? ""),
        author: String(row.author?.name ?? ""),
      };
    }
    const author = row.author ?? row.user ?? row.username ?? "";
    return {
      timestamp: parseTime(row.timestamp ?? row.time ?? row.offset),
      text: String(row.message ?? row.text ?? row.content ?? ""),
      author: String(typeof author === "object" ? author?.name ?? "" : author),
    };
  }

  /**
   * Reads what the export says about the video: title, channel, ID and, for a
   * trimmed TwitchDownloader export, where the clip starts in the stream.
   * Returns {} for formats that carry none of this.
   */
  function readChatInfo(raw) {
    const trimmed = String(raw).replace(/^\uFEFF/, "").trim();
    if (!trimmed.startsWith("{") || trimmed.includes("\n{\"")) return {};
    let payload;
    try {
      payload = JSON.parse(trimmed);
    } catch {
      return {};
    }
    const video = payload && typeof payload.video === "object" ? payload.video : null;
    if (!video) return {};
    const number = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
    return {
      platform: "twitch",
      title: video.title || "",
      channel: payload.streamer?.name || "",
      videoId: video.id ? String(video.id) : "",
      clipStart: number(video.start),
      clipEnd: number(video.end),
      streamLength: number(video.length),
      chapters: Array.isArray(video.chapters)
        ? video.chapters
          .map((c) => ({
            start: Number(c.startMilliseconds) / 1000,
            end: (Number(c.startMilliseconds) + Number(c.lengthMilliseconds)) / 1000,
            title: String(c.gameDisplayName || c.description || "Untitled"),
          }))
          .filter((c) => Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > c.start)
        : [],
    };
  }

  /**
   * Parses a chat export file's text into sorted messages.
   * @param {string} raw file contents
   * @param {string} fileName used to detect CSV vs JSON
   */
  function parseChatExport(raw, fileName = "") {
    const isCsv = fileName.toLowerCase().endsWith(".csv");
    let rows;
    if (isCsv) {
      rows = parseCsv(raw);
    } else {
      const trimmed = raw.trim();
      // Newline-delimited JSON (one message per line), as chat-downloader can emit.
      if (trimmed.startsWith("{") && trimmed.includes("\n{")) {
        try {
          rows = trimmed.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
        } catch {
          rows = null;
        }
      }
      if (!rows) {
        const payload = JSON.parse(trimmed);
        rows = Array.isArray(payload) ? payload : payload.comments || payload.messages || [];
      }
    }

    const messages = rows
      .flatMap((row) => (row && row.replayChatItemAction ? expandYtDlpRow(row) : [row]))
      .map(normalizeRow)
      .filter((m) => Number.isFinite(m.timestamp) && m.timestamp >= 0 && m.text.trim())
      .sort((a, b) => a.timestamp - b.timestamp);

    if (!messages.length) {
      throw new Error("No messages with a timestamp and text were found in this file.");
    }
    return messages;
  }

  // ---------------------------------------------------------------------------
  // Detection
  // ---------------------------------------------------------------------------

  function keywords(messages, limit = 5) {
    const counts = new Map();
    for (const message of messages) {
      // Count each word once per message so one spammer can't dominate.
      const words = new Set(message.text.toLowerCase().match(/[a-z][a-z0-9_']{2,}/g) || []);
      for (const word of words) {
        if (!STOP_WORDS.has(word)) counts.set(word, (counts.get(word) || 0) + 1);
      }
    }
    // A keyword has to come from at least two messages to say anything about the crowd.
    return [...counts]
      .filter(([, count]) => count >= 2)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, limit)
      .map(([word]) => word);
  }

  /**
   * Message counts per window, from the window holding the first message to the
   * one holding the last. Starting at the first message (not 0:00) matters for
   * trimmed exports: chat for 1:00:00-1:30:00 must not count an empty first hour
   * as the stream's normal pace.
   */
  function buildTimeline(messages, windowSeconds) {
    if (!messages.length) return { counts: [], start: 0 };
    const first = Math.floor(messages[0].timestamp / windowSeconds);
    const last = Math.floor(messages[messages.length - 1].timestamp / windowSeconds);
    const counts = new Array(last - first + 1).fill(0);
    for (const message of messages) counts[Math.floor(message.timestamp / windowSeconds) - first] += 1;
    return { counts, start: first * windowSeconds };
  }

  function stats(values) {
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
    return { mean, deviation: Math.sqrt(variance) };
  }

  /**
   * Finds chat spikes.
   *
   * Each window gets a z-score against the whole stream's average. Windows that
   * pass the threshold are merged with neighbours that also pass, so one long
   * reaction becomes one moment instead of several back-to-back ones.
   */
  function findMoments(messages, options = {}) {
    const windowSeconds = Number(options.windowSeconds ?? 15);
    const minMessages = Number(options.minMessages ?? 5);
    const threshold = Number(options.zThreshold ?? SENSITIVITY.medium);
    const maxMoments = Number(options.maxMoments ?? 25);

    if (!(windowSeconds > 0)) throw new Error("Window length must be more than 0 seconds.");
    if (!(minMessages >= 1)) throw new Error("Minimum messages must be at least 1.");
    if (!(threshold >= 0)) throw new Error("Spike threshold can't be negative.");

    const { counts, start: timelineStart } = buildTimeline(messages, windowSeconds);
    if (!counts.length) return { moments: [], timeline: [], timelineStart: 0, mean: 0, deviation: 0 };
    const at = (index) => timelineStart + index * windowSeconds; // window index -> stream seconds
    const { mean, deviation } = stats(counts);
    const zScores = counts.map((c) => (deviation ? (c - mean) / deviation : 0));
    const hot = counts.map((c, i) => c >= minMessages && zScores[i] >= threshold);

    // Group consecutive hot windows.
    const groups = [];
    for (let i = 0; i < counts.length; i += 1) {
      if (!hot[i]) continue;
      const previous = groups[groups.length - 1];
      if (previous && previous.end === i - 1) previous.end = i;
      else groups.push({ start: i, end: i });
    }

    let messageIndex = 0;
    const moments = groups.map((group) => {
      const windowStart = at(group.start);
      const windowEnd = at(group.end + 1);
      while (messageIndex < messages.length && messages[messageIndex].timestamp < windowStart) messageIndex += 1;
      const inside = [];
      for (let j = messageIndex; j < messages.length && messages[j].timestamp < windowEnd; j += 1) {
        inside.push(messages[j]);
      }

      // Where chat started rising: walk back from the spike through windows
      // that were already clearly above normal (up to 30s), since the cause
      // comes before the busiest window.
      let onsetIndex = group.start;
      const maxBack = Math.ceil(30 / windowSeconds);
      const rising = mean + 0.5 * deviation;
      while (onsetIndex > 0 && group.start - onsetIndex < maxBack && counts[onsetIndex - 1] >= rising) onsetIndex -= 1;

      let peakIndex = group.start;
      for (let i = group.start; i <= group.end; i += 1) if (counts[i] > counts[peakIndex]) peakIndex = i;
      const peakCount = counts[peakIndex];
      const topWords = keywords(inside);

      return {
        // Point at the start of the peak window, a little early, so playback
        // starts just before the reaction rather than in the middle of it.
        timestamp: Math.max(0, at(peakIndex) - windowSeconds),
        peakTime: at(peakIndex),
        onsetTime: at(onsetIndex),
        windowSeconds,
        windowStart,
        windowEnd,
        messageCount: inside.length,
        peakCount,
        baselineCount: Number(mean.toFixed(2)),
        zScore: Number(zScores[peakIndex].toFixed(2)),
        intensity: mean ? Number((peakCount / mean).toFixed(1)) : 0,
        uniqueChatters: new Set(inside.map((m) => m.author).filter(Boolean)).size,
        keywords: topWords,
        sampleMessages: pickSamples(inside, topWords, 6),
      };
    });

    moments.sort((a, b) => b.zScore - a.zScore || b.messageCount - a.messageCount);
    const top = moments.slice(0, maxMoments).map((moment, i) => ({ ...moment, rank: i + 1 }));
    return { moments: top, timeline: counts, timelineStart, mean, deviation };
  }

  /**
   * Picks varied sample messages. Messages that use the moment's keywords come
   * first, so samples show the reaction rather than unrelated background chat.
   */
  function pickSamples(messages, topWords, limit) {
    const wordSet = new Set(topWords);
    const score = (text) => (text.toLowerCase().match(/[a-z][a-z0-9_']{2,}/g) || []).filter((w) => wordSet.has(w)).length;
    const seen = new Set();
    const unique = [];
    messages.forEach((message, order) => {
      const key = message.text.trim().toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      unique.push({ message, order, score: score(message.text) });
    });
    return unique
      .sort((a, b) => (b.score > 0) - (a.score > 0) || a.order - b.order)
      .slice(0, limit)
      .map(({ message }) => ({ text: message.text, author: message.author }));
  }

  // ---------------------------------------------------------------------------
  // Formatting and export
  // ---------------------------------------------------------------------------

  function clock(seconds) {
    const s = Math.max(0, Math.floor(seconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = String(s % 60).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
  }

  /** Link that opens the VOD at the moment, or null if there's no video ID. */
  function vodLink(platform, videoId, seconds) {
    const id = String(videoId || "").trim();
    if (!id) return null;
    const s = Math.max(0, Math.floor(seconds));
    if (platform === "youtube") {
      return `https://www.youtube.com/watch?v=${encodeURIComponent(id)}&t=${s}s`;
    }
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return `https://www.twitch.tv/videos/${encodeURIComponent(id)}?t=${h}h${m}m${s % 60}s`;
  }

  /** Pulls a video ID out of a pasted Twitch/YouTube URL, or returns the input. */
  function extractVideoId(input) {
    const text = String(input || "").trim();
    const twitch = text.match(/twitch\.tv\/videos\/(\d+)/i);
    if (twitch) return { platform: "twitch", videoId: twitch[1] };
    const youtube = text.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|live\/|shorts\/)|youtu\.be\/)([\w-]{6,})/i);
    if (youtube) return { platform: "youtube", videoId: youtube[1] };
    return { platform: null, videoId: text };
  }

  function csvCell(value) {
    const text = String(value ?? "");
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  function toCsv(moments, platform, videoId) {
    const header = [
      "rank", "timestamp", "seconds", "messages", "peak_per_window", "intensity_x", "z_score",
      "reaction", "type", "existing_clips", "keywords", "ai_title", "ai_trigger", "ai_what_happened", "ai_confidence", "link", "note",
    ];
    const rows = moments.map((m) => [
      m.rank, clock(m.timestamp), Math.floor(m.timestamp), m.messageCount, m.peakCount, m.intensity, m.zScore,
      m.reaction || "", m.kind?.label || "", m.clips == null ? "" : m.clips.length, m.keywords.join(" | "),
      m.ai?.title || "", m.ai?.triggerLabel || "", m.ai?.whatHappened || "", m.ai?.confidence || "",
      vodLink(platform, videoId, m.timestamp) || "", m.note || "",
    ]);
    return [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\n");
  }

  /** YouTube-style chapter list, in time order. */
  function toChapters(moments) {
    return [...moments]
      .sort((a, b) => a.timestamp - b.timestamp)
      .map((m) => `${clock(m.timestamp)} ${m.note || m.ai?.title || m.keywords.slice(0, 3).join(" / ") || `Moment ${m.rank}`}`)
      .join("\n");
  }

  return {
    SENSITIVITY,
    parseTime,
    parseCsv,
    normalizeRow,
    parseChatExport,
    readChatInfo,
    keywords,
    buildTimeline,
    findMoments,
    clock,
    vodLink,
    extractVideoId,
    toCsv,
    toChapters,
  };
});
