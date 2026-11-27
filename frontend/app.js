/* Viewtopsy interface. Logic lives in analysis.js, reactions.js, frames.js and explain.js. */
(function () {
  "use strict";

  const A = window.ViewtopsyAnalysis;
  const R = window.ViewtopsyReactions;
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
    for (const m of state.result.moments) {
      state.reactions.set(m.windowStart, R.profile(messagesBetween(m.windowStart, m.windowEnd)));
    }
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
    renderMoments();
    updateExportHint();
    updateAiControls();
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
        for (const time of F.frameTimes(moment.peakTime, windowSeconds)) {
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
  }

  function paintFrames(moment) {
    const card = cardFor(moment.windowStart);
    if (!card) return;
    const strip = $(".filmstrip", card);
    const frames = state.frames.get(frameKey(moment));
    strip.replaceChildren();
    if (!state.grabber || !frames) {
      strip.hidden = true;
      return;
    }
    strip.hidden = false;
    if (frames === "loading") {
      for (let i = 0; i < F.FRAMES_PER_MOMENT; i += 1) strip.append(el("div", { className: "placeholder" }));
      return;
    }
    if (frames instanceof Error || !frames.length) {
      strip.append(el("p", { className: "hint", textContent: frames instanceof Error ? `Couldn't read frames: ${frames.message}` : "This moment is outside the video file." }));
      strip.style.gridTemplateColumns = "1fr";
      return;
    }
    strip.style.gridTemplateColumns = "";
    for (const frame of frames) {
      const button = el("button", { type: "button", title: `Frame at ${A.clock(frame.time)}` }, [
        el("img", { src: frame.dataUrl, alt: `Frame at ${A.clock(frame.time)}`, loading: "lazy" }),
        el("span", { textContent: A.clock(frame.time) }),
      ]);
      if (frame.time >= moment.peakTime && frame.time < moment.peakTime + settings().windowSeconds) button.classList.add("peak");
      button.addEventListener("click", () => openFrame(frame, moment));
      strip.append(button);
    }
  }

  function openFrame(frame, moment) {
    const dialog = $("#frame-viewer");
    $("img", dialog).src = frame.dataUrl;
    $(".frame-caption", dialog).textContent = `${A.clock(frame.time)} · moment #${moment.rank} (chat peaks at ${A.clock(moment.peakTime)})`;
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
    const chat = messagesBetween(moment.peakTime - F.LOOK_BACK, moment.windowEnd + 5);
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
    if (!todo.length) {
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
    state.aiBusy = false;
    updateAiControls();
    if (stopMessage) $("#ai-status").textContent = `Stopped: ${stopMessage}`;
  }

  function paintExplanation(moment) {
    const card = cardFor(moment.windowStart);
    if (!card) return;
    const box = $(".explanation", card);
    const explanation = state.explanations.get(moment.windowStart);
    box.replaceChildren();
    box.className = "explanation";
    if (!explanation) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    if (explanation.status === "loading") {
      box.classList.add("loading");
      box.append(el("p", { textContent: "Looking at the frames and chat…" }));
      return;
    }
    if (explanation.status === "error") {
      box.classList.add("error");
      box.append(el("p", { textContent: explanation.error }));
      return;
    }
    const d = explanation.data;
    const meta = el("div", { className: "meta" }, [
      el("span", { className: "tag", textContent: d.triggerLabel }),
      el("span", { className: `tag ${d.confidence}`, textContent: `${d.confidence} confidence` }),
      d.causeTime ? el("span", { className: "tag", textContent: `cause ≈ ${d.causeTime}` }) : null,
      d.model ? el("span", { className: "tag muted-tag", textContent: d.model }) : null,
    ]);
    box.append(...[
      el("h4", { textContent: d.title || "What happened" }),
      meta,
      d.whatHappened ? el("p", { textContent: d.whatHappened }) : null,
      d.whyChatReacted ? el("p", {}, [el("b", { textContent: "Why chat reacted: " }), d.whyChatReacted]) : null,
      d.evidence.length ? el("ul", {}, d.evidence.map((e) => el("li", { textContent: e }))) : null,
    ].filter(Boolean));
    // Offer the AI title as the note if the person hasn't written one.
    const note = $(".note-input", card);
    if (!note.value && d.title) note.placeholder = `Add a note or clip title… (suggested: ${d.title})`;
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
