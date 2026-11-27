/*
 * Explains why chat reacted, by showing a vision model the frames before the
 * spike together with what chat was saying.
 *
 * Works with Google Gemini (free tier available) or Anthropic Claude, using the
 * person's own API key, called straight from the browser. The provider is
 * worked out from the key, and for Gemini the best available Flash model is
 * picked automatically. Only the selected frames and chat text are sent, and
 * only when the person asks for an explanation.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.ViewtopsyExplain = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
  const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

  const PROVIDERS = {
    gemini: { label: "Google Gemini" },
    anthropic: { label: "Anthropic Claude" },
  };

  /** Claude models offered when an Anthropic key is used. */
  const MODELS = [
    { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5 (best explanations)" },
    { id: "claude-haiku-5-5", label: "Claude Haiku 5.5 (faster, cheaper)" },
  ];

  /** Used for Gemini when the model list can't be fetched. Newest first. */
  const GEMINI_FALLBACKS = ["gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.5-flash", "gemini-2.5-flash", "gemini-3.5-flash-lite", "gemini-2.5-flash-lite"];

  const TRIGGERS = {
    gameplay: "Gameplay",
    streamer: "Streamer's reaction or words",
    guest: "Guest or co-streamer",
    on_screen_media: "Video or media on screen",
    alert: "Alert, donation or sub",
    chat: "Chat itself (poll, meme, spam)",
    technical: "Technical issue",
    unclear: "Unclear",
  };

  function clock(seconds) {
    const s = Math.max(0, Math.floor(seconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = String(s % 60).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
  }

  /** Google keys start with "AIza", Anthropic keys with "sk-ant-". */
  function detectProvider(apiKey) {
    const key = String(apiKey || "").trim();
    if (/^sk-ant-/.test(key)) return "anthropic";
    if (/^AIza/.test(key)) return "gemini";
    return key ? "gemini" : null;
  }

  // ---------------------------------------------------------------------------
  // Prompt (shared by both providers)
  // ---------------------------------------------------------------------------

  /**
   * Builds the prompt as a list of parts: {text} or {image: base64 JPEG}.
   * @param {object} input
   *   moment: {peakTime, windowStart, windowEnd, messageCount, intensity}
   *   frames: [{time, dataUrl}] in stream seconds
   *   chat: [{timestamp, author, text}] around the spike
   *   reactions: {types:[{label, share}], readShare}
   *   context: {title, channel}
   */
  function buildPrompt(input) {
    const { moment, frames, chat, reactions, context = {} } = input;
    const reactionLine = reactions && reactions.types.length
      ? reactions.types.slice(0, 4).map((t) => `${t.label} ${Math.round(t.share * 100)}%`).join(", ")
      : "no clear emote pattern";

    const chatLines = chat
      .slice(0, 80)
      .map((m) => `[${clock(m.timestamp)}] ${m.author ? `${m.author}: ` : ""}${String(m.text).slice(0, 140)}`)
      .join("\n");

    const intro = [
      "You are helping a video editor understand a livestream moment.",
      context.title ? `Stream: "${context.title}"${context.channel ? ` by ${context.channel}` : ""}.` : "",
      `Chat spiked to ${moment.intensity}x its normal pace around ${clock(moment.peakTime)} (${moment.messageCount} messages between ${clock(moment.windowStart)} and ${clock(moment.windowEnd)}).`,
      `Chat's reaction, read from emotes and phrases: ${reactionLine}.`,
      `Below are ${frames.length} frames from the video in time order, covering the seconds before and during the spike. Chat usually reacts 3-15 seconds after what caused it.`,
      "Note: you cannot hear audio. If the frames don't show a cause, the streamer probably said or heard something; say so and use chat to infer what.",
    ].filter(Boolean).join(" ");

    const parts = [{ text: intro }];
    for (const frame of frames) {
      parts.push({ text: `Frame at ${clock(frame.time)}:` });
      parts.push({ image: frame.dataUrl.replace(/^data:image\/\w+;base64,/, "") });
    }
    parts.push({
      text: [
        `Chat messages around the spike:\n${chatLines || "(none)"}`,
        "",
        "Reply with only a JSON object, no other text:",
        "{",
        '  "title": "short clip title, max 8 words",',
        '  "what_happened": "one or two sentences on what happened, grounded in the frames and chat",',
        '  "why_chat_reacted": "one sentence on why chat reacted the way it did",',
        `  "trigger": one of ${JSON.stringify(Object.keys(TRIGGERS))},`,
        '  "cause_time": "H:MM:SS when the cause most likely happened, or null",',
        '  "confidence": "low" | "medium" | "high",',
        '  "evidence": ["2-4 short points: what you saw in which frame, or what chat said"]',
        "}",
        "Use low confidence when the frames don't clearly show the cause. Don't invent details you can't see or read.",
      ].join("\n"),
    });
    return parts;
  }

  /** Claude Messages API body. */
  function buildRequest(input, model) {
    const content = buildPrompt(input).map((part) => (part.image
      ? { type: "image", source: { type: "base64", media_type: "image/jpeg", data: part.image } }
      : { type: "text", text: part.text }));
    return { model, max_tokens: 700, messages: [{ role: "user", content }] };
  }

  /** Gemini generateContent body. */
  function buildGeminiRequest(input) {
    const parts = buildPrompt(input).map((part) => (part.image
      ? { inline_data: { mime_type: "image/jpeg", data: part.image } }
      : { text: part.text }));
    return {
      contents: [{ role: "user", parts }],
      generationConfig: { responseMimeType: "application/json", temperature: 0.4, maxOutputTokens: 2048 },
    };
  }

  // ---------------------------------------------------------------------------
  // Reading replies
  // ---------------------------------------------------------------------------

  /** Pulls the JSON object out of the model's text and checks its fields. */
  function parseExplanationText(text) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end <= start) throw new Error("The model didn't return an explanation in the expected format.");
    let data;
    try {
      data = JSON.parse(text.slice(start, end + 1));
    } catch {
      throw new Error("The model's explanation couldn't be read (invalid JSON).");
    }
    const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
    const confidence = ["low", "medium", "high"].includes(data.confidence) ? data.confidence : "low";
    const trigger = Object.prototype.hasOwnProperty.call(TRIGGERS, data.trigger) ? data.trigger : "unclear";
    return {
      title: str(data.title, 80),
      whatHappened: str(data.what_happened, 600),
      whyChatReacted: str(data.why_chat_reacted, 400),
      trigger,
      triggerLabel: TRIGGERS[trigger],
      causeTime: typeof data.cause_time === "string" ? data.cause_time.slice(0, 12) : null,
      confidence,
      evidence: Array.isArray(data.evidence) ? data.evidence.filter((e) => typeof e === "string").slice(0, 5).map((e) => e.slice(0, 200)) : [],
    };
  }

  /** Claude reply body. */
  function parseResponse(body) {
    const text = (body?.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
    return parseExplanationText(text);
  }

  /** Gemini reply body. */
  function parseGeminiResponse(body) {
    const candidate = body?.candidates?.[0];
    if (!candidate) {
      const reason = body?.promptFeedback?.blockReason;
      throw new Error(reason ? `Gemini declined these frames (${reason}).` : "Gemini returned no answer.");
    }
    const text = (candidate.content?.parts || []).filter((p) => typeof p.text === "string" && !p.thought).map((p) => p.text).join("");
    if (!text && candidate.finishReason && candidate.finishReason !== "STOP") {
      throw new Error(`Gemini stopped early (${candidate.finishReason}).`);
    }
    return parseExplanationText(text);
  }

  // ---------------------------------------------------------------------------
  // Choosing a Gemini model
  // ---------------------------------------------------------------------------

  /**
   * Orders the models a key can use for this task, best first: stable Flash
   * (newest version first), then stable Flash-Lite, then previews. Models for
   * images, speech, live audio, embeddings and so on are skipped.
   * @param {{name: string, supportedGenerationMethods?: string[]}[]} models
   */
  function rankGeminiModels(models) {
    const scored = [];
    for (const model of models || []) {
      const id = String(model.name || "").replace(/^models\//, "");
      if (model.supportedGenerationMethods && !model.supportedGenerationMethods.includes("generateContent")) continue;
      const match = id.match(/^gemini-(\d+(?:\.\d+)?)-flash(-lite)?(-preview(?:-[\w-]+)?|-\d{3}|-latest)?$/);
      if (!match) continue;
      const version = Number(match[1]);
      const lite = Boolean(match[2]);
      const suffix = match[3] || "";
      const preview = suffix.startsWith("-preview");
      const pinned = /^-\d{3}$/.test(suffix) || suffix === "-latest";
      // Stable flash beats lite beats preview; newer beats older within each.
      const tier = preview ? 0 : lite ? 1 : 2;
      scored.push({ id, score: tier * 1000 + version * 10 - (pinned ? 1 : 0) });
    }
    return scored.sort((a, b) => b.score - a.score).map((m) => m.id);
  }

  async function listGeminiModels(apiKey, fetchImpl) {
    const response = await fetchImpl(`${GEMINI_BASE}/models?pageSize=1000`, { headers: { "x-goog-api-key": apiKey } });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw apiError("gemini", response.status, body);
    return rankGeminiModels(body?.models || []);
  }

  // ---------------------------------------------------------------------------
  // Calling the APIs
  // ---------------------------------------------------------------------------

  function apiError(provider, status, body) {
    const detail = body?.error?.message || `HTTP ${status}`;
    const error = new Error(`The API returned an error: ${detail}`);
    error.status = status;
    if (status === 401 || (provider === "gemini" && status === 400 && /api key/i.test(detail)) || (status === 403 && /api key|permission/i.test(detail))) {
      error.message = "The API key was rejected. Check it and try again.";
      error.fatal = true;
    } else if (status === 404) {
      error.message = `Model not found: ${detail}`;
      error.tryNextModel = true;
    } else if (status === 429) {
      // "limit: 0" means this model has no free quota on this key; another model may.
      if (/limit:\s*0\b/.test(detail)) {
        error.message = "This model has no free quota on your key.";
        error.tryNextModel = true;
      } else {
        error.message = "Rate limited by the API. Wait a minute and try again.";
        error.fatal = true;
      }
    }
    return error;
  }

  async function post(url, headers, body, provider, fetchImpl) {
    let response;
    try {
      response = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    } catch {
      const error = new Error(`Couldn't reach ${PROVIDERS[provider].label}. Check your connection.`);
      error.fatal = true;
      throw error;
    }
    const json = await response.json().catch(() => null);
    if (!response.ok) throw apiError(provider, response.status, json);
    return json;
  }

  /**
   * Creates an explainer for one API key. It remembers which Gemini model
   * worked, so later moments go straight to it.
   * @param {{apiKey: string, model?: string, fetchImpl?: Function}} options
   *   model: "auto" (default) or a specific model id.
   */
  function createExplainer({ apiKey, model = "auto", fetchImpl = typeof fetch !== "undefined" ? fetch.bind(globalThis) : null } = {}) {
    const key = String(apiKey || "").trim();
    const provider = detectProvider(key);
    let candidates = null; // Gemini models to try, best first
    let chosen = model !== "auto" ? model : null;

    async function geminiCandidates() {
      if (chosen) return [chosen];
      if (!candidates) {
        try {
          candidates = await listGeminiModels(key, fetchImpl);
        } catch (error) {
          if (error.fatal) throw error;
          candidates = [];
        }
        if (!candidates.length) candidates = GEMINI_FALLBACKS.slice();
      }
      return candidates;
    }

    return {
      provider,
      get model() {
        return chosen;
      },
      async models() {
        if (provider === "anthropic") return MODELS.map((m) => m.id);
        return geminiCandidates();
      },
      async explain(input) {
        if (!key) throw new Error("Add an API key first.");
        if (!input.frames.length) throw new Error("No frames to look at. Add the video file first.");

        if (provider === "anthropic") {
          const id = chosen || MODELS[0].id;
          const body = await post(ANTHROPIC_URL, {
            "x-api-key": key,
            "anthropic-version": "2023-06-01",
            "anthropic-dangerous-direct-browser-access": "true",
          }, buildRequest(input, id), provider, fetchImpl);
          chosen = id;
          return { ...parseResponse(body), provider, model: id };
        }

        let lastError = null;
        for (const id of await geminiCandidates()) {
          try {
            const body = await post(`${GEMINI_BASE}/models/${encodeURIComponent(id)}:generateContent`, { "x-goog-api-key": key }, buildGeminiRequest(input), provider, fetchImpl);
            chosen = id;
            return { ...parseGeminiResponse(body), provider, model: id };
          } catch (error) {
            lastError = error;
            if (!error.tryNextModel || chosen === id) throw error;
            if (candidates) candidates = candidates.filter((c) => c !== id);
          }
        }
        throw lastError || new Error("No Gemini model on this key could look at images.");
      },
    };
  }

  /** One-off explanation (kept for simple callers and tests). */
  async function explain(input, options = {}) {
    return createExplainer(options).explain(input);
  }

  return {
    PROVIDERS,
    MODELS,
    TRIGGERS,
    GEMINI_FALLBACKS,
    detectProvider,
    buildPrompt,
    buildRequest,
    buildGeminiRequest,
    parseResponse,
    parseGeminiResponse,
    rankGeminiModels,
    createExplainer,
    explain,
  };
});
