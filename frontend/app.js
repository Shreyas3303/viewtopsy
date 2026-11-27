/* Viewtopsy interface. Logic lives in analysis.js, reactions.js, frames.js and explain.js. */
(function () {
  "use strict";

  const A = window.ViewtopsyAnalysis;
  const R = window.ViewtopsyReactions;
  const I = window.ViewtopsyInsights;
  const F = window.ViewtopsyFrames;
  const X = window.ViewtopsyExplain;
  const Sample = window.ViewtopsySample;
  const SVG_NS = "http://www.w3.org/2000/svg";
  const KEY_STORAGE = "viewtopsy.aiKey";

  const $ = (selector, scope = document) => scope.querySelector(selector);
  const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];

  const state = {
    messages: [],
    sourceName: "",
    info: {}, // what the chat export says about the video (title, channel, trim start)
    platform: "twitch",
    videoId: "",
    result: null,
    reactions: new Map(), // moment key -> reaction profile
    kinds: new Map(), // moment key -> {id, label, hint}
    quiet: [], // quiet stretches
    segments: null,
    clips: [], // existing Twitch clips, if loaded
    clipMatch: null, // {byMoment, unmatched}
    starred: new Set(), // moment keys (windowStart, in stream seconds)
    notes: new Map(),
    grabber: null,
    videoOffset: 0, // stream time at which the video file starts
    frames: new Map(), // `${key}@${offset}` -> [{time, dataUrl}] | "loading" | Error
    explanations: new Map(), // key -> {status: "loading"|"done"|"error", data, error}
    apiKey: "",
    explainer: null, // one per key and model choice; remembers the Gemini model that worked
  };

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function setStatus(text, kind = "") {
    const status = $("#file-status");
    status.textContent = text;
    status.className = `file-status ${kind}`;
  }

  let toastTimer;
  function toast(text) {
    const el = $("#toast");
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const area = Object.assign(document.createElement("textarea"), { value: text });
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.append(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    }
  }

  function download(fileName, text, type) {
    const blob = new Blob([text], { type });
    const link = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: fileName });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  function el(tag, props = {}, children = []) {
    const node = Object.assign(document.createElement(tag), props);
    for (const child of [].concat(children)) if (child != null) node.append(child);
    return node;
  }

  function storage(action, value) {
    try {
      if (action === "get") return localStorage.getItem(KEY_STORAGE) || "";
      if (action === "set") localStorage.setItem(KEY_STORAGE, value);
      if (action === "clear") localStorage.removeItem(KEY_STORAGE);
    } catch {
      /* storage unavailable: key stays in memory only */
    }
    return "";
  }

  function fileStem() {
    const base = state.videoId || state.sourceName.replace(/\.[^.]+$/, "") || "stream";
    return `viewtopsy-${base}`.replace(/[^\w.-]+/g, "-");
  }

  function settings() {
    const custom = $("#z-threshold").value.trim();
    const sensitivity = $("input[name=sensitivity]:checked").value;
    return {
      windowSeconds: Number($("#window-seconds").value),
      minMessages: Number($("#min-messages").value),
      zThreshold: custom === "" ? A.SENSITIVITY[sensitivity] : Number(custom),
      maxMoments: 30,
    };
  }

  function messagesBetween(from, to) {
    // messages are sorted; a linear scan is fine for interactive sizes
    return state.messages.filter((m) => m.timestamp >= from && m.timestamp < to);
  }

  function enrichedMoments() {
    return state.result.moments.map((m) => {
      const explanation = state.explanations.get(m.windowStart);
      const reactions = state.reactions.get(m.windowStart);
      return {
        ...m,
        starred: state.starred.has(m.windowStart),
        note: state.notes.get(m.windowStart) || "",
        reaction: reactions ? R.describe(reactions) : "",
        reactionShares: reactions ? Object.fromEntries(reactions.types.map((t) => [t.id, Number(t.share.toFixed(2))])) : {},
        ai: explanation && explanation.status === "done" ? explanation.data : null,
        kind: state.kinds.get(m.windowStart) || null,
        clips: state.clipMatch ? state.clipMatch.byMoment.get(m.windowStart) || [] : null,
      };
    });
  }

  function exportableMoments() {
    const all = enrichedMoments();
    const starred = all.filter((m) => m.starred);
    return starred.length ? starred : all;
  }

  // ---------------------------------------------------------------------------
  // Loading chat
  // ---------------------------------------------------------------------------

  function acceptChat(messages, sourceName, info = {}) {
    state.messages = messages;
    state.sourceName = sourceName;
    state.info = info;
    state.starred.clear();
    state.notes.clear();
    state.explanations.clear();
    state.frames.clear();
    state.clips = [];
    state.clipMatch = null;
    $("#clips-status").textContent = "";

    const first = messages[0].timestamp;
    const last = messages[messages.length - 1].timestamp;
    const span = first > 60 ? `${A.clock(first)}–${A.clock(last)}` : `${A.clock(last)} long`;
    const what = info.title ? `“${info.title}”${info.channel ? ` (${info.channel})` : ""}` : sourceName;
    setStatus(`✓ ${what} · ${messages.length.toLocaleString()} messages · ${span}`, "ok");
    $("#analyze-button").disabled = false;

    if (info.videoId && !$("#video-input").value.trim()) {
      $("#video-input").value = `https://www.twitch.tv/videos/${info.videoId}`;
      updatePlatformHint();
    }
    // A trimmed TwitchDownloader export says where its clip starts; a video
    // downloaded with the same trim starts at that same point.
    setVideoOffset(info.clipStart != null ? info.clipStart : 0);
  }

  function loadFile(file) {
    if (file.size > 300 * 1024 * 1024) {
      setStatus("That file is over 300 MB, which is too big to open in the browser.", "error");
      return;
    }
    if (/^video\//.test(file.type)) {
      setStatus("That's a video. Add the chat file here first; you can add the video on the next screen.", "error");
      return;
    }
    setStatus(`Reading ${file.name}…`);
    const reader = new FileReader();
    reader.onerror = () => setStatus("Couldn't read that file.", "error");
    reader.onload = () => {
      try {
        const raw = String(reader.result);
        acceptChat(A.parseChatExport(raw, file.name), file.name, A.readChatInfo(raw));
      } catch (error) {
        state.messages = [];
        $("#analyze-button").disabled = true;
        const reason = error instanceof SyntaxError ? "it isn't valid JSON" : error.message;
        setStatus(`Couldn't use ${file.name}: ${reason}`, "error");
      }
    };
    reader.readAsText(file);
  }

  function loadSample() {
    const rows = Sample.generateSampleChat();
    $("#video-input").value = "";
    acceptChat(A.parseChatExport(JSON.stringify(rows), "sample.json"), "Sample stream");
    updatePlatformHint();
    analyze();
  }

  function updatePlatformHint() {
    const { platform, videoId } = A.extractVideoId($("#video-input").value);
    const hint = $("#platform-hint");
    if (platform) {
      $(`input[name=platform][value=${platform}]`).checked = true;
      hint.textContent = `Detected ${platform === "twitch" ? "Twitch" : "YouTube"} video ${videoId}`;
    } else {
      hint.textContent = "";
    }
  }

  // ---------------------------------------------------------------------------
  // Analysis + rendering
  // ---------------------------------------------------------------------------

  function analyze() {
    if (!state.messages.length) return;
    const parsed = A.extractVideoId($("#video-input").value);
    state.videoId = parsed.videoId;
    state.platform = parsed.platform || $("input[name=platform]:checked").value;
    $("#setup").hidden = true;
    $("#results").hidden = false; // shown first so the chart can measure its width
    runDetection();
    window.scrollTo({ top: 0 });
  }

  function runDetection() {
    try {
      state.result = A.findMoments(state.messages, settings());
    } catch (error) {
      toast(error.message);
      return;
    }
    state.reactions.clear();
    state.kinds.clear();
    for (const m of state.result.moments) {
      const inside = messagesBetween(m.windowStart, m.windowEnd);
      const profile = R.profile(inside);
      state.reactions.set(m.windowStart, profile);
      state.kinds.set(m.windowStart, I.momentKind(inside, profile));
    }
    const windowSeconds = settings().windowSeconds;
    state.quiet = I.findQuietStretches(state.messages, state.result, { windowSeconds });
    state.segments = I.segmentScores(state.messages, state.result, { chapters: state.info.chapters || [], quiet: state.quiet });
    state.clipMatch = state.clips.length ? I.matchClips(state.result.moments, state.clips) : null;
    render();
    loadFrames();
  }

  function render() {
    const { moments } = state.result;
    const messages = state.messages;
    const chatters = new Set(messages.map((m) => m.author).filter(Boolean)).size;
    const first = messages[0].timestamp;
    const last = messages[messages.length - 1].timestamp;

    const label = state.info.title
      ? `${state.info.channel ? `${state.info.channel} · ` : ""}${state.info.title}`
      : state.videoId ? `${state.platform === "youtube" ? "YouTube" : "Twitch"} · ${state.videoId}` : state.sourceName;
    $("#source-label").textContent = label;
    $("#result-title").textContent = moments.length
      ? `${moments.length} moment${moments.length === 1 ? "" : "s"} worth a look`
      : "No standout moments yet";
    $("#metric-messages").textContent = messages.length.toLocaleString();
    if (first > 60) {
      $("#metric-duration").textContent = `${A.clock(first)}–${A.clock(last)}`;
      $("#metric-duration-label").textContent = "part of stream";
    } else {
      $("#metric-duration").textContent = A.clock(last);
      $("#metric-duration-label").textContent = "stream length";
    }
    $("#metric-chatters").textContent = chatters ? chatters.toLocaleString() : "—";
    $("#metric-moments").textContent = moments.length;
    $("#empty-state").hidden = moments.length > 0;
    $(".export").hidden = moments.length === 0;

    const overall = R.profile(messages);
    const overallText = overall.types.slice(0, 4).map((t) => `${t.label.toLowerCase()} ${Math.round(t.share * 100)}%`).join(", ");
    $("#chat-overall").innerHTML = "";
    $("#chat-overall").append(
      el("b", { textContent: "Chat overall: " }),
      overall.types.length
        ? `${overallText}. ${Math.round(overall.readShare * 100)}% of messages had a recognisable reaction.`
        : "no recognisable emote patterns.",
    );

    renderTimeline();
    renderSegments();
    renderMoments();
    renderQuiet();
    renderUnmatchedClips();
    updateExportHint();
    updateAiControls();
  }

  function renderSegments() {
    const panel = $("#segments-panel");
    const data = state.segments;
    if (!data || data.segments.length < 2) {
      panel.hidden = true;
      return;
    }
    panel.hidden = false;
    $("#segments-basis").textContent = data.basis === "chapters"
      ? "By game / category from the VOD’s chapters · 1.0× = the stream’s normal pace"
      : "By time block · 1.0× = the stream’s normal pace";
    const max = Math.max(1.5, ...data.segments.map((s) => s.relative));
    const host = $("#segments");
    host.replaceChildren();
    for (const seg of data.segments) {
      const bar = el("div", { className: "segment-bar", title: `${seg.perMinute} messages a minute` }, [
        el("span", { className: seg.relative >= 1.25 ? "hot" : "" }),
        el("i"),
      ]);
      bar.firstChild.style.width = `${Math.min(100, (seg.relative / max) * 100)}%`;
      bar.lastChild.style.left = `${(1 / max) * 100}%`;
      const meta = el("span", { className: "segment-meta" }, [
        el("b", { textContent: `${seg.relative.toFixed(1)}×` }),
        ` · ${A.clock(seg.duration)} · ${seg.momentCount} moment${seg.momentCount === 1 ? "" : "s"}`,
        seg.quietSeconds >= 60 ? ` · ${Math.round(seg.quietSeconds / 60)} min quiet` : "",
      ]);
      host.append(el("div", { className: "segment" }, [el("span", { className: "segment-title", textContent: seg.title, title: seg.title }), bar, meta]));
    }
  }

  function renderUnmatchedClips() {
    const section = $("#unclipped-section");
    const list = $("#unmatched-clips");
    list.replaceChildren();
    const clips = state.clipMatch ? state.clipMatch.unmatched.slice(0, 8) : [];
    section.hidden = clips.length === 0;
    for (const clip of clips) {
      list.append(el("li", {}, [
        el("b", { textContent: A.clock(clip.start) }),
        clip.url ? el("a", { href: clip.url, target: "_blank", rel: "noopener noreferrer", textContent: clip.title || "Untitled clip" }) : clip.title,
        el("span", { className: "hint", textContent: `${clip.views.toLocaleString()} views${clip.creator ? ` · by ${clip.creator}` : ""}` }),
      ]));
    }
  }

  function renderMoments() {
    const list = $("#moment-list");
    list.replaceChildren();
    const sortBy = $("input[name=sort]:checked").value;
    const moments = [...enrichedMoments()].sort((a, b) => (sortBy === "time" ? a.timestamp - b.timestamp : a.rank - b.rank));
    const maxIntensity = Math.max(1, ...moments.map((m) => m.intensity));

    for (const moment of moments) {
      const card = $("#moment-template").content.firstElementChild.cloneNode(true);
      const key = moment.windowStart;
      card.dataset.key = key;

      $(".moment-rank", card).textContent = `#${moment.rank}`;
      const time = $(".moment-time", card);
      time.textContent = A.clock(moment.timestamp);
      time.addEventListener("click", () => copyText(A.clock(moment.timestamp)).then(() => toast(`Copied ${A.clock(moment.timestamp)}`)));

      $(".intensity-fill", card).style.width = `${Math.max(8, (moment.intensity / maxIntensity) * 100)}%`;
      $(".moment-stats", card).replaceChildren(
        `${moment.intensity}× normal chat`,
        el("span", {
          className: "muted",
          textContent: ` · ${moment.messageCount} messages${moment.uniqueChatters ? ` from ${moment.uniqueChatters} chatters` : ""} · ${A.clock(moment.windowEnd - moment.windowStart)} burst`,
        }),
      );

      // Spike type
      const badge = $(".kind-badge", card);
      if (moment.kind) {
        badge.textContent = moment.kind.label;
        badge.dataset.kind = moment.kind.id;
        badge.title = moment.kind.hint;
      } else {
        badge.remove();
      }

      // Existing clips
      const clipStatus = $(".clip-status", card);
      if (moment.clips) {
        clipStatus.hidden = false;
        if (!moment.clips.length) {
          clipStatus.classList.add("gem");
          clipStatus.textContent = "✦ Nobody has clipped this yet";
        } else {
          const top = moment.clips[0];
          clipStatus.append(
            `Already clipped ${moment.clips.length}× · top: `,
            top.url ? el("a", { href: top.url, target: "_blank", rel: "noopener noreferrer", textContent: top.title || "clip" }) : top.title,
            ` (${top.views.toLocaleString()} views)`,
          );
        }
      }

      // Reactions
      const reactions = state.reactions.get(key);
      $(".reaction-summary", card).textContent = reactions ? R.describe(reactions) : "";
      const chips = $(".reaction-chips", card);
      for (const type of (reactions?.types || []).slice(0, 4)) {
        chips.append(el("li", { textContent: `${type.label} ${Math.round(type.share * 100)}%` }));
        chips.lastChild.dataset.type = type.id;
      }

      const link = $(".watch-link", card);
      const href = A.vodLink(state.platform, state.videoId, moment.timestamp);
      if (href) link.href = href;
      else link.remove();

      const star = $(".star-button", card);
      const paintStar = () => {
        const on = state.starred.has(key);
        star.textContent = on ? "★" : "☆";
        star.setAttribute("aria-pressed", String(on));
        star.title = on ? "Unstar" : "Star this moment";
        card.classList.toggle("starred", on);
      };
      paintStar();
      star.addEventListener("click", () => {
        if (state.starred.has(key)) state.starred.delete(key);
        else state.starred.add(key);
        paintStar();
        updateExportHint();
        renderTimeline();
      });

      $(".explain-button", card).addEventListener("click", () => explainMoment(moment));

      const keywordList = $(".keyword-list", card);
      if (moment.keywords.length) {
        for (const word of moment.keywords) keywordList.append(el("li", { textContent: word }));
      } else {
        keywordList.remove();
      }

      const samples = $(".sample-list", card);
      for (const sample of moment.sampleMessages) {
        const li = el("li", { title: sample.text });
        if (sample.author) li.append(el("b", { textContent: sample.author }));
        li.append(sample.text);
        samples.append(li);
      }

      const note = $(".note-input", card);
      note.value = moment.note;
      note.addEventListener("input", () => {
        if (note.value.trim()) state.notes.set(key, note.value.trim());
        else state.notes.delete(key);
      });

      list.append(card);
      paintFrames(moment);
      paintExplanation(moment);
    }
    updateAiControls();
  }

  function updateExportHint() {
    const count = state.starred.size;
    $("#export-hint").textContent = count
      ? `Exports your ${count} starred moment${count === 1 ? "" : "s"}.`
      : "Exports all moments. Star some to export just those.";
  }

  function cardFor(key) {
    return $(`.moment-card[data-key="${key}"]`);
  }

  function focusMoment(key) {
    const card = cardFor(key);
    if (!card) return;
    card.scrollIntoView({ behavior: "smooth", block: "center" });
    card.classList.add("flash");
    card.focus({ preventScroll: true });
    setTimeout(() => card.classList.remove("flash"), 1400);
    $$(".timeline .marker").forEach((m) => m.classList.toggle("active", m.dataset.key === String(key)));
  }

  // ---------------------------------------------------------------------------
  // Video frames
  // ---------------------------------------------------------------------------

  function setVideoOffset(seconds) {
    state.videoOffset = Math.max(0, Number(seconds) || 0);
    $("#video-offset").value = A.clock(state.videoOffset);
  }

  function frameKey(moment) {
    return `${moment.windowStart}@${state.videoOffset}`;
  }

  async function loadVideo(file) {
    if (state.grabber) state.grabber.dispose();
    state.frames.clear();
    const status = $("#video-status");
    status.textContent = `Opening ${file.name}…`;
    const grabber = new F.FrameGrabber(file);
    state.grabber = grabber;
    try {
      const duration = await grabber.ready;
      if (state.grabber !== grabber) return;
      const first = state.messages[0].timestamp;
      const last = state.messages[state.messages.length - 1].timestamp;
      const videoEnd = state.videoOffset + duration;
      let note = "";
      if (last < state.videoOffset || first > videoEnd) {
        note = " ⚠ The chat and video don't overlap. Check “Video starts at”.";
      } else if (Math.abs(duration - (last - first)) > 120 && first > 60 && state.videoOffset === 0) {
        note = " ⚠ The chat starts later than the video. If the video is a trimmed clip, set “Video starts at” to where it begins.";
      }
      status.textContent = `✓ ${file.name} · ${A.clock(duration)} long, covering ${A.clock(state.videoOffset)}–${A.clock(videoEnd)} of the stream.${note}`;
      renderMoments();
      loadFrames();
    } catch (error) {
      state.grabber = null;
      status.textContent = error.message;
    }
  }

  async function loadFrames() {
    const grabber = state.grabber;
    if (!grabber || !state.result) return;
    const windowSeconds = settings().windowSeconds;
    // Biggest moments first.
    for (const moment of state.result.moments) {
      const key = frameKey(moment);
      if (state.frames.has(key)) continue;
      state.frames.set(key, "loading");
      paintFrames(moment);
      const frames = [];
      try {
        for (const time of F.frameTimes(moment.onsetTime ?? moment.peakTime, windowSeconds)) {
          const videoTime = time - state.videoOffset;
          if (videoTime < 0 || videoTime > grabber.duration) continue;
          frames.push({ time, dataUrl: await grabber.grab(videoTime) });
        }
        if (state.grabber !== grabber) return;
        state.frames.set(key, frames);
      } catch (error) {
        state.frames.set(key, error);
      }
      paintFrames(moment);
      updateAiControls();
    }
    for (const zone of state.quiet) {
      const key = quietFrameKey(zone);
      if (state.frames.has(key)) continue;
      state.frames.set(key, "loading");
      paintQuiet(zone);
      const frames = [];
      try {
        for (const time of quietFrameTimes(zone)) {
          const videoTime = time - state.videoOffset;
          if (videoTime < 0 || videoTime > grabber.duration) continue;
          frames.push({ time, dataUrl: await grabber.grab(videoTime) });
        }
        if (state.grabber !== grabber) return;
        state.frames.set(key, frames);
      } catch (error) {
        state.frames.set(key, error);
      }
      paintQuiet(zone);
    }
  }

  function paintFrames(moment) {
    const card = cardFor(moment.windowStart);
    if (!card) return;
    fillStrip($(".filmstrip", card), state.frames.get(frameKey(moment)), {
      count: F.FRAMES_PER_MOMENT,
      highlightFrom: moment.onsetTime ?? moment.peakTime,
      onOpen: (frame) => openFrame(frame, moment),
      outside: "This moment is outside the video file.",
    });
  }

  /** Draws a row of frames, a loading shimmer, or an error into `strip`. */
  function fillStrip(strip, frames, { count, highlightFrom = Infinity, onOpen, outside }) {
    strip.replaceChildren();
    if (!state.grabber || !frames) {
      strip.hidden = true;
      return;
    }
    strip.hidden = false;
    if (frames === "loading") {
      for (let i = 0; i < count; i += 1) strip.append(el("div", { className: "placeholder" }));
      return;
    }
    if (frames instanceof Error || !frames.length) {
      strip.append(el("p", { className: "hint", textContent: frames instanceof Error ? `Couldn't read frames: ${frames.message}` : outside }));
      strip.style.gridTemplateColumns = "1fr";
      return;
    }
    strip.style.gridTemplateColumns = "";
    for (const frame of frames) {
      const button = el("button", { type: "button", title: `Frame at ${A.clock(frame.time)}` }, [
        el("img", { src: frame.dataUrl, alt: `Frame at ${A.clock(frame.time)}`, loading: "lazy" }),
        el("span", { textContent: A.clock(frame.time) }),
      ]);
      if (frame.time >= highlightFrom) button.classList.add("peak");
      button.addEventListener("click", () => onOpen(frame));
      strip.append(button);
    }
  }

  function openFrame(frame, moment) {
    const dialog = $("#frame-viewer");
    $("img", dialog).src = frame.dataUrl;
    $(".frame-caption", dialog).textContent = moment.rank
      ? `${A.clock(frame.time)} · moment #${moment.rank} (chat starts rising at ${A.clock(moment.onsetTime ?? moment.peakTime)}, peaks at ${A.clock(moment.peakTime)})`
      : `${A.clock(frame.time)} · quiet stretch ${A.clock(moment.start)}–${A.clock(moment.end)}`;
    if (dialog.showModal) dialog.showModal();
  }

  // ---------------------------------------------------------------------------
  // AI explanations
  // ---------------------------------------------------------------------------

  function framesReady(moment) {
    const frames = state.frames.get(frameKey(moment));
    return Array.isArray(frames) && frames.length ? frames : null;
  }

  function updateAiControls() {
    const hasKey = Boolean(state.apiKey);
    const readyCount = state.result ? state.result.moments.filter(framesReady).length : 0;
    $("#explain-all").disabled = !(hasKey && readyCount);
    for (const card of $$(".moment-card")) {
      const moment = state.result.moments.find((m) => String(m.windowStart) === card.dataset.key);
      const button = $(".explain-button", card);
      const explanation = state.explanations.get(moment.windowStart);
      button.hidden = !(hasKey && framesReady(moment));
      button.disabled = explanation?.status === "loading";
      button.textContent = explanation?.status === "done" ? "Re-explain" : "Explain";
    }
    for (const zone of state.quiet) paintQuietButton(zone);
    const lag = I.reactionLag(enrichedMoments());
    $("#ai-lag").textContent = lag
      ? `Measured from ${lag.count} explained moment${lag.count === 1 ? "" : "s"}: chat starts reacting about ${lag.median}s after the cause (range ${lag.min}–${lag.max}s).`
      : "";
    const status = $("#ai-status");
    if (state.aiBusy) return;
    if (!state.grabber) status.textContent = "Add the video file to enable explanations.";
    else if (!hasKey) status.textContent = "Add your API key to enable explanations.";
    else status.textContent = `${readyCount} moment${readyCount === 1 ? "" : "s"} ready to explain${providerNote()}.`;
  }

  function providerNote() {
    const ex = state.explainer;
    if (!ex) return "";
    const name = X.PROVIDERS[ex.provider]?.label || "";
    return ex.model ? ` with ${name} (${ex.model})` : ` with ${name}`;
  }

  function getExplainer() {
    const model = $("#ai-model").value || "auto";
    const ex = state.explainer;
    if (!ex || ex.key !== state.apiKey || ex.choice !== model) {
      state.explainer = Object.assign(X.createExplainer({ apiKey: state.apiKey, model }), { key: state.apiKey, choice: model });
    }
    return state.explainer;
  }

  /** Fills the model menu for the provider the key belongs to. */
  function refreshModelMenu() {
    const select = $("#ai-model");
    const previous = select.value;
    const provider = X.detectProvider(state.apiKey);
    select.replaceChildren(el("option", { value: "auto", textContent: provider === "anthropic" ? "Automatic (Claude Sonnet)" : "Automatic (best free Gemini model)" }));
    if (provider === "anthropic") {
      for (const m of X.MODELS) select.append(el("option", { value: m.id, textContent: m.label }));
    } else if (provider === "gemini") {
      for (const id of X.GEMINI_FALLBACKS) select.append(el("option", { value: id, textContent: id }));
    }
    select.value = [...select.options].some((o) => o.value === previous) ? previous : "auto";
  }

  async function explainMoment(moment) {
    const frames = framesReady(moment);
    if (!frames || !state.apiKey) return;
    const key = moment.windowStart;
    state.explanations.set(key, { status: "loading" });
    paintExplanation(moment);
    updateAiControls();
    const windowSeconds = settings().windowSeconds;
    const chat = messagesBetween((moment.onsetTime ?? moment.peakTime) - F.LOOK_BACK, moment.windowEnd + 5);
    const step = Math.max(1, Math.ceil(chat.length / 80)); // spread the sample across the whole spike
    try {
      const data = await getExplainer().explain(
        {
          moment: { ...moment, peakTime: moment.peakTime + windowSeconds / 2 },
          frames,
          chat: chat.filter((_, i) => i % step === 0),
          reactions: state.reactions.get(key),
          context: { title: state.info.title, channel: state.info.channel },
        },
      );
      state.explanations.set(key, { status: "done", data });
    } catch (error) {
      state.explanations.set(key, { status: "error", error: error.message, fatal: Boolean(error.fatal) });
    }
    paintExplanation(moment);
    updateAiControls();
  }

  async function explainAll() {
    const todo = state.result.moments.filter((m) => framesReady(m) && state.explanations.get(m.windowStart)?.status !== "done");
    const quietTodo = state.quiet.filter((z) => !z.nearEdge && Array.isArray(state.frames.get(quietFrameKey(z))) && state.explanations.get(quietKey(z))?.status !== "done");
    if (!todo.length && !quietTodo.length) {
      toast("Every moment with frames is already explained.");
      return;
    }
    $("#explain-all").disabled = true;
    state.aiBusy = true;
    let stopMessage = "";
    for (const [i, moment] of todo.entries()) {
      $("#ai-status").textContent = `Explaining ${i + 1} of ${todo.length}${providerNote()}…`;
      await explainMoment(moment);
      const result = state.explanations.get(moment.windowStart);
      if (result?.status === "error" && result.fatal) {
        stopMessage = result.error;
        break;
      }
    }
    const zones = stopMessage ? [] : state.quiet.filter((z) => !z.nearEdge && Array.isArray(state.frames.get(quietFrameKey(z))) && state.explanations.get(quietKey(z))?.status !== "done");
    for (const [i, zone] of zones.entries()) {
      $("#ai-status").textContent = `Explaining quiet stretch ${i + 1} of ${zones.length}${providerNote()}…`;
      await explainQuiet(zone);
      const result = state.explanations.get(quietKey(zone));
      if (result?.status === "error" && result.fatal) {
        stopMessage = result.error;
        break;
      }
    }
    state.aiBusy = false;
    updateAiControls();
    if (stopMessage) $("#ai-status").textContent = `Stopped: ${stopMessage}`;
  }

  function paintExplanation(moment) {
    const card = cardFor(moment.windowStart);
    if (!card) return;
    const explanation = state.explanations.get(moment.windowStart);
    fillExplanation($(".explanation", card), explanation, "Looking at the frames and chat…");
    // Offer the AI title as the note if the person hasn't written one.
    const d = explanation?.status === "done" ? explanation.data : null;
    const note = $(".note-input", card);
    if (d && !note.value && d.title) note.placeholder = `Add a note or clip title… (suggested: ${d.title})`;
  }

  function fillExplanation(box, explanation, loadingText) {
    box.replaceChildren();
    box.className = "explanation";
    if (!explanation) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    if (explanation.status === "loading") {
      box.classList.add("loading");
      box.append(el("p", { textContent: loadingText }));
      return;
    }
    if (explanation.status === "error") {
      box.classList.add("error");
      box.append(el("p", { textContent: explanation.error }));
      return;
    }
    const d = explanation.data;
    const quiet = explanation.kind === "quiet";
    const meta = el("div", { className: "meta" }, [
      !quiet || d.trigger !== "unclear" ? el("span", { className: "tag", textContent: d.triggerLabel }) : null,
      el("span", { className: `tag ${d.confidence}`, textContent: `${d.confidence} confidence` }),
      d.causeTime && !quiet ? el("span", { className: "tag", textContent: `cause ≈ ${d.causeTime}` }) : null,
      d.model ? el("span", { className: "tag muted-tag", textContent: d.model }) : null,
    ]);
    box.append(...[
      el("h4", { textContent: d.title || (quiet ? "What was happening" : "What happened") }),
      meta,
      d.whatHappened ? el("p", { textContent: d.whatHappened }) : null,
      d.whyChatReacted ? el("p", {}, [el("b", { textContent: quiet ? "Why chat went quiet: " : "Why chat reacted: " }), d.whyChatReacted]) : null,
      quiet && d.suggestion ? el("p", { className: "suggestion" }, [el("b", { textContent: "Suggestion: " }), d.suggestion]) : null,
      d.evidence.length ? el("ul", {}, d.evidence.map((e) => el("li", { textContent: e }))) : null,
    ].filter(Boolean));
  }

  // ---------------------------------------------------------------------------
  // Quiet stretches
  // ---------------------------------------------------------------------------

  const QUIET_FRAMES = 4;
  const quietKey = (zone) => `q${zone.start}`;
  const quietFrameKey = (zone) => `${quietKey(zone)}@${state.videoOffset}`;
  const quietCard = (zone) => $(`.quiet-card[data-key="${quietKey(zone)}"]`);

  function renderQuiet() {
    const section = $("#quiet-section");
    const list = $("#quiet-list");
    list.replaceChildren();
    section.hidden = state.quiet.length === 0;
    for (const zone of [...state.quiet].sort((a, b) => a.start - b.start)) {
      const card = $("#quiet-template").content.firstElementChild.cloneNode(true);
      card.dataset.key = quietKey(zone);
      $(".quiet-time", card).textContent = `${A.clock(zone.start)}–${A.clock(zone.end)}`;
      $(".quiet-stats", card).textContent = `${Math.round(zone.duration / 60)} min at ${Math.round(zone.pace * 100)}% of normal chat · ${zone.messageCount} messages${zone.nearEdge ? " · near the start/end of the stream" : ""}`;
      const link = $(".watch-link", card);
      const href = A.vodLink(state.platform, state.videoId, zone.start);
      if (href) link.href = href;
      else link.remove();
      $(".explain-button", card).addEventListener("click", () => explainQuiet(zone));
      const samples = $(".sample-list", card);
      for (const sample of zone.samples) {
        const li = el("li", { title: sample.text });
        if (sample.author) li.append(el("b", { textContent: sample.author }));
        li.append(sample.text);
        samples.append(li);
      }
      list.append(card);
      paintQuiet(zone);
    }
  }

  function quietFrameTimes(zone) {
    return Array.from({ length: QUIET_FRAMES }, (_, i) => zone.start + ((i + 0.5) / QUIET_FRAMES) * zone.duration);
  }

  function paintQuiet(zone) {
    const card = quietCard(zone);
    if (!card) return;
    fillStrip($(".filmstrip", card), state.frames.get(quietFrameKey(zone)), {
      count: QUIET_FRAMES,
      onOpen: (frame) => openFrame(frame, zone),
      outside: "This stretch is outside the video file.",
    });
    fillExplanation($(".explanation", card), state.explanations.get(quietKey(zone)), "Looking at what was happening…");
    paintQuietButton(zone);
  }

  function paintQuietButton(zone) {
    const card = quietCard(zone);
    if (!card) return;
    const frames = state.frames.get(quietFrameKey(zone));
    const button = $(".explain-button", card);
    const explanation = state.explanations.get(quietKey(zone));
    button.hidden = !(state.apiKey && Array.isArray(frames) && frames.length);
    button.disabled = explanation?.status === "loading";
    button.textContent = explanation?.status === "done" ? "Re-explain" : "Explain";
  }

  async function explainQuiet(zone) {
    const frames = state.frames.get(quietFrameKey(zone));
    if (!Array.isArray(frames) || !frames.length || !state.apiKey) return;
    const key = quietKey(zone);
    state.explanations.set(key, { status: "loading", kind: "quiet" });
    paintQuiet(zone);
    try {
      const chat = messagesBetween(zone.start, zone.end);
      const data = await getExplainer().explain({
        kind: "quiet",
        zone,
        frames,
        chat,
        context: { title: state.info.title, channel: state.info.channel },
      });
      state.explanations.set(key, { status: "done", kind: "quiet", data });
    } catch (error) {
      state.explanations.set(key, { status: "error", kind: "quiet", error: error.message, fatal: Boolean(error.fatal) });
    }
    paintQuiet(zone);
  }

  // ---------------------------------------------------------------------------
  // Timeline chart
  // ---------------------------------------------------------------------------

  function svg(tag, attrs = {}) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    return node;
  }

  function niceStep(totalSeconds, targetTicks) {
    const steps = [60, 120, 300, 600, 900, 1800, 3600, 7200, 10800];
    return steps.find((s) => totalSeconds / s <= targetTicks) || 21600;
  }

  function renderTimeline() {
    const host = $("#timeline");
    host.replaceChildren();
    if (!state.result) return;
    const { timeline, timelineStart, moments, mean } = state.result;
    const windowSeconds = settings().windowSeconds;

    const width = host.clientWidth || 800;
    const height = host.clientHeight || 190;
    const pad = { top: 18, right: 8, bottom: 22, left: 8 };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;
    const total = timeline.length * windowSeconds;
    const peak = Math.max(1, ...timeline);

    const x = (seconds) => pad.left + ((seconds - timelineStart) / total) * plotW;
    const y = (count) => pad.top + plotH - (count / peak) * plotH;

    const root = svg("svg", { viewBox: `0 0 ${width} ${height}` });
    for (const zone of state.quiet) {
      root.append(svg("rect", { class: "quiet-band", x: x(zone.start), y: pad.top, width: Math.max(1, x(zone.end) - x(zone.start)), height: plotH }));
    }
    const points = timeline.map((count, i) => `${x(timelineStart + (i + 0.5) * windowSeconds).toFixed(1)},${y(count).toFixed(1)}`);
    root.append(svg("path", { class: "area", d: `M${x(timelineStart)},${y(0)} L${points.join(" L")} L${x(timelineStart + total)},${y(0)} Z` }));
    root.append(svg("path", { class: "line", d: `M${points.join(" L")}` }));

    root.append(svg("line", { class: "baseline", x1: pad.left, x2: width - pad.right, y1: y(mean), y2: y(mean) }));
    const baseLabel = svg("text", { class: "baseline-label", x: width - pad.right, y: y(mean) - 4, "text-anchor": "end" });
    baseLabel.textContent = "normal pace";
    root.append(baseLabel);

    const axis = svg("g", { class: "axis" });
    const step = niceStep(total, Math.max(3, Math.floor(plotW / 90)));
    const firstTick = Math.ceil(timelineStart / step) * step;
    for (let t = firstTick; t <= timelineStart + total; t += step) {
      const label = svg("text", { x: x(t), y: height - 4, "text-anchor": t === timelineStart ? "start" : "middle" });
      label.textContent = A.clock(t);
      axis.append(label);
    }
    root.append(axis);

    for (const clip of state.clips) {
      if (clip.start < timelineStart || clip.start > timelineStart + total) continue;
      const cx = x(clip.start + clip.duration / 2);
      const tick = svg("line", { class: "clip-tick", x1: cx, x2: cx, y1: pad.top + plotH - 14, y2: pad.top + plotH });
      const title = svg("title");
      title.textContent = `Clip: ${clip.title} (${clip.views.toLocaleString()} views)`;
      tick.append(title);
      root.append(tick);
    }

    const hoverLine = svg("line", { class: "hover-line", y1: pad.top, y2: pad.top + plotH, visibility: "hidden" });
    root.append(hoverLine);

    for (const moment of [...moments].sort((a, b) => b.rank - a.rank)) {
      const marker = svg("g", {
        class: `marker${state.starred.has(moment.windowStart) ? " starred" : ""}`,
        tabindex: "0",
        role: "button",
        "aria-label": `Moment ${moment.rank} at ${A.clock(moment.timestamp)}`,
        "data-key": moment.windowStart,
      });
      const cx = x(moment.peakTime + windowSeconds / 2);
      const cy = Math.max(pad.top - 4, y(moment.peakCount) - 12);
      marker.append(svg("circle", { cx, cy, r: 9 }));
      const label = svg("text", { x: cx, y: cy });
      label.textContent = moment.rank;
      marker.append(label);
      marker.addEventListener("click", () => focusMoment(moment.windowStart));
      marker.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          focusMoment(moment.windowStart);
        }
      });
      root.append(marker);
    }

    const tooltip = $("#timeline-tooltip");
    root.addEventListener("mousemove", (event) => {
      const rect = root.getBoundingClientRect();
      const px = ((event.clientX - rect.left) / rect.width) * width;
      const offset = Math.min(total - 1, Math.max(0, ((px - pad.left) / plotW) * total));
      const index = Math.floor(offset / windowSeconds);
      hoverLine.setAttribute("x1", px);
      hoverLine.setAttribute("x2", px);
      hoverLine.setAttribute("visibility", "visible");
      tooltip.hidden = false;
      tooltip.textContent = `${A.clock(timelineStart + index * windowSeconds)} · ${timeline[index] ?? 0} msgs / ${windowSeconds}s`;
      const panelRect = host.parentElement.getBoundingClientRect();
      tooltip.style.left = `${Math.min(panelRect.width - 70, Math.max(70, event.clientX - panelRect.left))}px`;
    });
    root.addEventListener("mouseleave", () => {
      hoverLine.setAttribute("visibility", "hidden");
      tooltip.hidden = true;
    });

    host.append(root);
  }

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------

  function dropZone(zone, input, onFile) {
    input.addEventListener("change", (event) => {
      const file = event.target.files[0];
      if (file) onFile(file);
    });
    zone.addEventListener("dragover", (event) => { event.preventDefault(); zone.classList.add("dragging"); });
    zone.addEventListener("dragleave", () => zone.classList.remove("dragging"));
    zone.addEventListener("drop", (event) => {
      event.preventDefault();
      zone.classList.remove("dragging");
      const file = event.dataTransfer.files[0];
      if (file) onFile(file);
    });
  }

  dropZone($("#upload-zone"), $("#chat-file"), loadFile);
  dropZone($("#video-zone"), $("#video-file"), (file) => {
    if (!state.messages.length) return;
    loadVideo(file);
  });

  $("#video-offset").addEventListener("change", () => {
    const seconds = A.parseTime($("#video-offset").value);
    if (!Number.isFinite(seconds) || seconds < 0) {
      toast("Use a time like 1:00:00");
      setVideoOffset(state.videoOffset);
      return;
    }
    setVideoOffset(seconds);
    if (state.grabber) loadVideo(state.grabber.file);
  });

  $("#sample-button").addEventListener("click", loadSample);
  $("#video-input").addEventListener("input", updatePlatformHint);
  $("#setup-form").addEventListener("submit", (event) => {
    event.preventDefault();
    analyze();
  });

  $("#new-analysis").addEventListener("click", () => {
    $("#results").hidden = true;
    $("#setup").hidden = false;
    window.scrollTo({ top: 0 });
  });

  $$("input[name=sensitivity]").forEach((input) => input.addEventListener("change", () => {
    $("#z-threshold").value = "";
    runDetection();
  }));
  ["#window-seconds", "#min-messages", "#z-threshold"].forEach((selector) => {
    $(selector).addEventListener("change", runDetection);
  });
  $$("input[name=sort]").forEach((input) => input.addEventListener("change", renderMoments));
  $$("[data-sensitivity]").forEach((button) => button.addEventListener("click", () => {
    $(`input[name=sensitivity][value=${button.dataset.sensitivity}]`).checked = true;
    $("#z-threshold").value = "";
    runDetection();
  }));

  // AI settings
  const savedKey = storage("get");
  if (savedKey) {
    state.apiKey = savedKey;
    $("#api-key").value = savedKey;
    $("#remember-key").checked = true;
  }
  refreshModelMenu();
  $("#api-key").addEventListener("input", () => {
    state.apiKey = $("#api-key").value.trim();
    if ($("#remember-key").checked) storage("set", state.apiKey);
    refreshModelMenu();
    if (state.result) updateAiControls();
  });
  $("#ai-model").addEventListener("change", () => {
    if (state.result) updateAiControls();
  });
  $("#remember-key").addEventListener("change", () => {
    if ($("#remember-key").checked && state.apiKey) storage("set", state.apiKey);
    else storage("clear");
  });
  $("#explain-all").addEventListener("click", explainAll);

  // Existing clips
  dropZone($("#clips-zone"), $("#clips-file"), (file) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const clips = I.parseClips(String(reader.result), state.videoId);
        state.clips = clips;
        if (!clips.length) {
          $("#clips-status").textContent = "No clips with a position in this VOD were found in that file.";
        } else {
          const first = state.messages[0]?.timestamp ?? 0;
          const last = state.messages[state.messages.length - 1]?.timestamp ?? Infinity;
          const inRange = clips.filter((c) => c.start + c.duration >= first && c.start <= last).length;
          $("#clips-status").textContent = `✓ ${clips.length} clip${clips.length === 1 ? "" : "s"} loaded · ${inRange} within this chat’s time range.`;
        }
        if (state.result) runDetection();
      } catch (error) {
        $("#clips-status").textContent = `Couldn't read that file: ${error instanceof SyntaxError ? "it isn't valid JSON" : error.message}`;
      }
    };
    reader.readAsText(file);
  });

  // Editor markers
  function editorOptions() {
    return {
      videoOffset: state.videoOffset,
      fps: Number($("#export-fps").value),
      title: state.info.title ? `${state.info.channel ? `${state.info.channel} - ` : ""}${state.info.title}` : "Viewtopsy markers",
      videoName: state.grabber?.file?.name || (state.videoId ? `${state.videoId}.mp4` : "video.mp4"),
      videoDuration: state.grabber?.duration || 0,
    };
  }
  $("#download-edl").addEventListener("click", () => {
    download(`${fileStem()}-resolve-markers.edl`, I.toResolveEdl(exportableMoments(), editorOptions()), "text/plain");
  });
  $("#download-xml").addEventListener("click", () => {
    download(`${fileStem()}-markers.xml`, I.toPremiereXml(exportableMoments(), editorOptions()), "application/xml");
  });

  // Export
  $("#copy-chapters").addEventListener("click", () => {
    copyText(A.toChapters(exportableMoments())).then(() => toast("Chapters copied to clipboard"));
  });
  $("#download-csv").addEventListener("click", () => {
    download(`${fileStem()}.csv`, A.toCsv(exportableMoments(), state.platform, state.videoId), "text/csv");
  });
  $("#download-json").addEventListener("click", () => {
    const payload = {
      tool: "viewtopsy",
      source: state.sourceName,
      stream: state.info.title ? { title: state.info.title, channel: state.info.channel } : null,
      platform: state.platform,
      videoId: state.videoId || null,
      settings: settings(),
      moments: exportableMoments().map((m) => ({ ...m, link: A.vodLink(state.platform, state.videoId, m.timestamp) })),
      quietStretches: state.quiet.map((z) => ({
        ...z,
        link: A.vodLink(state.platform, state.videoId, z.start),
        ai: state.explanations.get(quietKey(z))?.status === "done" ? state.explanations.get(quietKey(z)).data : null,
      })),
      segments: state.segments,
    };
    download(`${fileStem()}.json`, JSON.stringify(payload, null, 2), "application/json");
  });

  let resizeTimer;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(renderTimeline, 120);
  });

  setStatus("No file chosen yet.");
})();
