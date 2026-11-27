/*
 * Explains why chat reacted, by showing a vision model the frames before the
 * spike together with what chat was saying.
 *
 * Calls the Claude Messages API straight from the browser with the person's own
 * API key. Only the selected frames and chat text are sent, and only when the
 * person clicks Explain.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.ViewtopsyExplain = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const API_URL = "https://api.anthropic.com/v1/messages";
  const MODELS = [
    { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5 (best explanations)" },
    { id: "claude-haiku-5-5", label: "Claude Haiku 5.5 (faster, cheaper)" },
  ];

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

  /**
   * Builds the request body.
   * @param {object} input
   *   moment: {peakTime, windowStart, windowEnd, messageCount, intensity}
   *   frames: [{time, dataUrl}] in stream seconds
   *   chat: [{timestamp, author, text}] around the spike
   *   reactions: {types:[{label, share}], readShare}
   *   context: {title, channel}
   */
  function buildRequest(input, model) {
    const { moment, frames, chat, reactions, context = {} } = input;
    const reactionLine = reactions && reactions.types.length
      ? reactions.types.slice(0, 4).map((t) => `${t.label} ${Math.round(t.share * 100)}%`).join(", ")
      : "no clear emote pattern";

    const chatLines = chat
      .slice(0, 80)
      .map((m) => `[${clock(m.timestamp)}] ${m.author ? `${m.author}: ` : ""}${String(m.text).slice(0, 140)}`)
      .join("\n");

    const intro = [
      `You are helping a video editor understand a livestream moment.`,
      context.title ? `Stream: "${context.title}"${context.channel ? ` by ${context.channel}` : ""}.` : "",
      `Chat spiked to ${moment.intensity}x its normal pace around ${clock(moment.peakTime)} (${moment.messageCount} messages between ${clock(moment.windowStart)} and ${clock(moment.windowEnd)}).`,
      `Chat's reaction, read from emotes and phrases: ${reactionLine}.`,
      `Below are ${frames.length} frames from the video in time order, covering the seconds before and during the spike. Chat usually reacts 3-15 seconds after what caused it.`,
      `Note: you cannot hear audio. If the frames don't show a cause, the streamer probably said or heard something; say so and use chat to infer what.`,
    ].filter(Boolean).join(" ");

    const content = [{ type: "text", text: intro }];
    for (const frame of frames) {
      content.push({ type: "text", text: `Frame at ${clock(frame.time)}:` });
      content.push({
        type: "image",
        source: { type: "base64", media_type: "image/jpeg", data: frame.dataUrl.replace(/^data:image\/\w+;base64,/, "") },
      });
    }
    content.push({
      type: "text",
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

    return { model, max_tokens: 700, messages: [{ role: "user", content }] };
  }

  /** Pulls the JSON object out of the model's reply and checks its fields. */
  function parseResponse(body) {
    const text = (body?.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
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

  /** Sends the request. Throws an Error with a readable message on failure. */
  async function explain(input, { apiKey, model = MODELS[0].id, fetchImpl = typeof fetch !== "undefined" ? fetch : null } = {}) {
    if (!apiKey) throw new Error("Add an API key first.");
    if (!input.frames.length) throw new Error("No frames to look at. Add the video file first.");
    let response;
    try {
      response = await fetchImpl(API_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify(buildRequest(input, model)),
      });
    } catch {
      throw new Error("Couldn't reach the Claude API. Check your connection.");
    }
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (!response.ok) {
      const detail = body?.error?.message || `HTTP ${response.status}`;
      if (response.status === 401) throw new Error("The API key was rejected. Check it and try again.");
      if (response.status === 404) throw new Error(`Model not found: ${detail}. Try the other model in settings.`);
      if (response.status === 429) throw new Error("Rate limited by the API. Wait a moment and try again.");
      throw new Error(`The API returned an error: ${detail}`);
    }
    return parseResponse(body);
  }

  return { MODELS, TRIGGERS, buildRequest, parseResponse, explain };
});
