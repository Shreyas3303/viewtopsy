/* Viewtopsy interface. Analysis logic lives in analysis.js. */
(function () {
  "use strict";

  const A = window.ViewtopsyAnalysis;
  const Sample = window.ViewtopsySample;
  const SVG_NS = "http://www.w3.org/2000/svg";

  const $ = (selector, scope = document) => scope.querySelector(selector);
  const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];

  const state = {
    messages: [],
    sourceName: "",
    platform: "twitch",
    videoId: "",
    result: null,
    starred: new Set(), // keyed by moment.windowStart
    notes: new Map(),
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
    toastTimer = setTimeout(() => { el.hidden = true; }, 2200);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Fallback for file:// pages and older browsers.
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

  function momentsWithNotes() {
    return state.result.moments.map((m) => ({
      ...m,
      starred: state.starred.has(m.windowStart),
      note: state.notes.get(m.windowStart) || "",
    }));
  }

  function exportableMoments() {
    const all = momentsWithNotes();
    const starred = all.filter((m) => m.starred);
    return starred.length ? starred : all;
  }

  // ---------------------------------------------------------------------------
  // Loading
  // ---------------------------------------------------------------------------

  function acceptMessages(messages, sourceName) {
    state.messages = messages;
    state.sourceName = sourceName;
    state.starred.clear();
    state.notes.clear();
    const duration = A.clock(messages[messages.length - 1].timestamp);
    setStatus(`✓ ${sourceName} · ${messages.length.toLocaleString()} messages · ${duration} long`, "ok");
    $("#analyze-button").disabled = false;
  }

  function loadFile(file) {
    if (file.size > 300 * 1024 * 1024) {
      setStatus("That file is over 300 MB, which is too big to open in the browser.", "error");
      return;
    }
    setStatus(`Reading ${file.name}…`);
    const reader = new FileReader();
    reader.onerror = () => setStatus("Couldn't read that file.", "error");
    reader.onload = () => {
      try {
        acceptMessages(A.parseChatExport(String(reader.result), file.name), file.name);
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
    acceptMessages(A.parseChatExport(JSON.stringify(rows), "sample.json"), "Sample stream");
    $("#video-input").value = "";
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
    // Show the panel first so the chart can measure its real width.
    $("#setup").hidden = true;
    $("#results").hidden = false;
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
    render();
  }

  function render() {
    const { moments } = state.result;
    const messages = state.messages;
    const chatters = new Set(messages.map((m) => m.author).filter(Boolean)).size;

    $("#source-label").textContent = state.videoId
      ? `${state.platform === "youtube" ? "YouTube" : "Twitch"} · ${state.videoId}`
      : state.sourceName;
    $("#result-title").textContent = moments.length
      ? `${moments.length} moment${moments.length === 1 ? "" : "s"} worth a look`
      : "No standout moments yet";
    $("#metric-messages").textContent = messages.length.toLocaleString();
    $("#metric-duration").textContent = A.clock(messages[messages.length - 1].timestamp);
    $("#metric-chatters").textContent = chatters ? chatters.toLocaleString() : "—";
    $("#metric-moments").textContent = moments.length;
    $("#empty-state").hidden = moments.length > 0;
    $(".export").hidden = moments.length === 0;

    renderTimeline();
    renderMoments();
    updateExportHint();
  }

  function renderMoments() {
    const list = $("#moment-list");
    list.replaceChildren();
    const sortBy = $("input[name=sort]:checked").value;
    const moments = [...momentsWithNotes()].sort((a, b) =>
      sortBy === "time" ? a.timestamp - b.timestamp : a.rank - b.rank,
    );
    const maxIntensity = Math.max(1, ...moments.map((m) => m.intensity));

    for (const moment of moments) {
      const card = $("#moment-template").content.firstElementChild.cloneNode(true);
      card.dataset.key = moment.windowStart;
      card.classList.toggle("starred", moment.starred);

      $(".moment-rank", card).textContent = `#${moment.rank}`;
      const time = $(".moment-time", card);
      time.textContent = A.clock(moment.timestamp);
      time.addEventListener("click", () => copyText(A.clock(moment.timestamp)).then(() => toast(`Copied ${A.clock(moment.timestamp)}`)));

      $(".intensity-fill", card).style.width = `${Math.max(8, (moment.intensity / maxIntensity) * 100)}%`;
      const stats = $(".moment-stats", card);
      stats.innerHTML = "";
      stats.append(
        `${moment.intensity}× normal chat`,
        Object.assign(document.createElement("span"), {
          className: "muted",
          textContent: ` · ${moment.messageCount} messages${moment.uniqueChatters ? ` from ${moment.uniqueChatters} chatters` : ""} · ${A.clock(moment.windowEnd - moment.windowStart)} burst`,
        }),
      );

      const link = $(".watch-link", card);
      const href = A.vodLink(state.platform, state.videoId, moment.timestamp);
      if (href) link.href = href;
      else link.remove();

      const star = $(".star-button", card);
      const paintStar = () => {
        const on = state.starred.has(moment.windowStart);
        star.textContent = on ? "★" : "☆";
        star.setAttribute("aria-pressed", String(on));
        star.title = on ? "Unstar" : "Star this moment";
        card.classList.toggle("starred", on);
      };
      paintStar();
      star.addEventListener("click", () => {
        if (state.starred.has(moment.windowStart)) state.starred.delete(moment.windowStart);
        else state.starred.add(moment.windowStart);
        paintStar();
        updateExportHint();
        renderTimeline();
      });

      const keywordList = $(".keyword-list", card);
      if (moment.keywords.length) {
        for (const word of moment.keywords) keywordList.append(Object.assign(document.createElement("li"), { textContent: word }));
      } else {
        keywordList.remove();
      }

      const samples = $(".sample-list", card);
      for (const sample of moment.sampleMessages) {
        const li = document.createElement("li");
        if (sample.author) li.append(Object.assign(document.createElement("b"), { textContent: sample.author }));
        li.append(sample.text);
        li.title = sample.text;
        samples.append(li);
      }

      const note = $(".note-input", card);
      note.value = moment.note;
      note.addEventListener("input", () => {
        if (note.value.trim()) state.notes.set(moment.windowStart, note.value.trim());
        else state.notes.delete(moment.windowStart);
      });

      list.append(card);
    }
  }

  function updateExportHint() {
    const count = state.starred.size;
    $("#export-hint").textContent = count
      ? `Exports your ${count} starred moment${count === 1 ? "" : "s"}.`
      : "Exports all moments. Star some to export just those.";
  }

  function focusMoment(key) {
    const card = $(`.moment-card[data-key="${key}"]`);
    if (!card) return;
    card.scrollIntoView({ behavior: "smooth", block: "center" });
    card.classList.add("flash");
    card.focus({ preventScroll: true });
    setTimeout(() => card.classList.remove("flash"), 1400);
    $$(".timeline .marker").forEach((m) => m.classList.toggle("active", m.dataset.key === String(key)));
  }

  // ---------------------------------------------------------------------------
  // Timeline chart (plain SVG, redrawn at the container's real width)
  // ---------------------------------------------------------------------------

  function svg(tag, attrs = {}) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
    return el;
  }

  function niceStep(totalSeconds, targetTicks) {
    const steps = [60, 300, 600, 900, 1800, 3600, 7200, 10800];
    return steps.find((s) => totalSeconds / s <= targetTicks) || 21600;
  }

  function renderTimeline() {
    const host = $("#timeline");
    host.replaceChildren();
    if (!state.result) return;
    const { timeline, moments, mean } = state.result;
    const windowSeconds = settings().windowSeconds;

    const width = host.clientWidth || 800;
    const height = host.clientHeight || 190;
    const pad = { top: 18, right: 8, bottom: 22, left: 8 };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;
    const total = timeline.length * windowSeconds;
    const peak = Math.max(1, ...timeline);

    const x = (seconds) => pad.left + (seconds / total) * plotW;
    const y = (count) => pad.top + plotH - (count / peak) * plotH;

    const root = svg("svg", { viewBox: `0 0 ${width} ${height}` });

    // Activity area + line
    const points = timeline.map((count, i) => `${x((i + 0.5) * windowSeconds).toFixed(1)},${y(count).toFixed(1)}`);
    root.append(svg("path", { class: "area", d: `M${x(0)},${y(0)} L${points.join(" L")} L${x(total)},${y(0)} Z` }));
    root.append(svg("path", { class: "line", d: `M${points.join(" L")}` }));

    // Normal-pace line
    root.append(svg("line", { class: "baseline", x1: pad.left, x2: width - pad.right, y1: y(mean), y2: y(mean) }));
    const baseLabel = svg("text", { class: "baseline-label", x: width - pad.right, y: y(mean) - 4, "text-anchor": "end" });
    baseLabel.textContent = "normal pace";
    root.append(baseLabel);

    // Time axis
    const axis = svg("g", { class: "axis" });
    const step = niceStep(total, Math.max(3, Math.floor(plotW / 90)));
    for (let t = 0; t <= total; t += step) {
      const label = svg("text", { x: x(t), y: height - 4, "text-anchor": t === 0 ? "start" : "middle" });
      label.textContent = A.clock(t);
      axis.append(label);
    }
    root.append(axis);

    // Hover guide
    const hoverLine = svg("line", { class: "hover-line", y1: pad.top, y2: pad.top + plotH, visibility: "hidden" });
    root.append(hoverLine);

    // Moment markers (drawn small-rank last so #1 sits on top)
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
      const seconds = Math.min(total - 1, Math.max(0, ((px - pad.left) / plotW) * total));
      const index = Math.floor(seconds / windowSeconds);
      hoverLine.setAttribute("x1", px);
      hoverLine.setAttribute("x2", px);
      hoverLine.setAttribute("visibility", "visible");
      tooltip.hidden = false;
      tooltip.textContent = `${A.clock(index * windowSeconds)} · ${timeline[index] ?? 0} msgs / ${windowSeconds}s`;
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

  $("#chat-file").addEventListener("change", (event) => {
    const file = event.target.files[0];
    if (file) loadFile(file);
  });

  const zone = $("#upload-zone");
  zone.addEventListener("dragover", (event) => { event.preventDefault(); zone.classList.add("dragging"); });
  zone.addEventListener("dragleave", () => zone.classList.remove("dragging"));
  zone.addEventListener("drop", (event) => {
    event.preventDefault();
    zone.classList.remove("dragging");
    const file = event.dataTransfer.files[0];
    if (file) loadFile(file);
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

  // Detection settings re-run instantly.
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
