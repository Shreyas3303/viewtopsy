// Run with: npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const A = require("../frontend/analysis.js");
const R = require("../frontend/reactions.js");
const X = require("../frontend/explain.js");

// ---------------------------------------------------------------------------
// Reactions
// ---------------------------------------------------------------------------

test("reads emotes, phrases and stretched words", () => {
  const cases = {
    KEKW: ["laughter"],
    "he screamed LMAOOO": ["laughter"],
    "NO WAY": ["shock"],
    monkaS: ["tension"],
    W: ["hype"],
    wwwww: ["hype"],
    "LETS GOOOO": ["hype"],
    Sadge: ["sad"],
    "<3": ["love"],
    "???": ["confusion"],
    "thank you for the 50 gifted!": ["support"],
    YES: ["voting"],
    "ITS ASS": ["voting"],
    cohhLUL: ["laughter"],
    kaicenatW: ["hype"],
    "what game is this": [],
  };
  for (const [text, expected] of Object.entries(cases)) {
    assert.deepEqual(R.classifyMessage(text), expected, text);
  }
});

test("lowercase w, l and f are not read as emotes", () => {
  assert.deepEqual(R.classifyMessage("w"), []);
  assert.deepEqual(R.classifyMessage("l"), []);
  assert.deepEqual(R.classifyMessage("f"), []);
});

test("profile and description of a moment", () => {
  const msgs = ["KEKW", "LMAO", "KEKW", "lol", "NO WAY", "nice chat", "what game"].map((text) => ({ text }));
  const p = R.profile(msgs);
  assert.equal(p.dominant, "laughter");
  assert.equal(p.types[0].count, 4);
  assert.equal(Math.round(p.readShare * 100), 71);
  assert.equal(R.describe(p), "Mostly laughter, some shock");
  assert.equal(R.describe(R.profile([{ text: "ok then" }])), "No clear reaction in chat");
});

// ---------------------------------------------------------------------------
// Trimmed exports
// ---------------------------------------------------------------------------

const trimmedExport = JSON.stringify({
  streamer: { name: "KaiCenat" },
  video: { title: "KAI VS SPEED", id: "2939504732", start: 3600, end: 5400, length: 17889 },
  comments: [3600, 3610, 3700].map((t, i) => ({ content_offset_seconds: t, commenter: { display_name: `u${i}` }, message: { body: "W" } })),
});

test("reads title, channel and trim start from a TwitchDownloader export", () => {
  assert.deepEqual(A.readChatInfo(trimmedExport), {
    platform: "twitch", title: "KAI VS SPEED", channel: "KaiCenat", videoId: "2939504732",
    clipStart: 3600, clipEnd: 5400, streamLength: 17889, chapters: [], emotes: [],
  });
  assert.deepEqual(A.readChatInfo("[]"), {});
  assert.deepEqual(A.readChatInfo("not json"), {});
});

test("timeline of a trimmed export starts at the clip, not 0:00", () => {
  const messages = A.parseChatExport(trimmedExport, "kai.json");
  const { timelineStart, timeline } = A.findMoments(messages, { minMessages: 1 });
  assert.equal(timelineStart, 3600);
  assert.equal(timeline.length, 7); // 3600..3705 in 15s windows
});

// ---------------------------------------------------------------------------
// AI explanations
// ---------------------------------------------------------------------------

const input = {
  moment: { peakTime: 4005, windowStart: 3990, windowEnd: 4020, messageCount: 140, intensity: 3.3 },
  frames: [{ time: 3985, dataUrl: "data:image/jpeg;base64,AAAA" }, { time: 3995, dataUrl: "data:image/jpeg;base64,BBBB" }],
  chat: [{ timestamp: 4001, author: "amy", text: "LMAOOO" }],
  reactions: { types: [{ label: "Laughter", share: 0.8 }], readShare: 0.4 },
  context: { title: "KAI VS SPEED", channel: "KaiCenat" },
};

test("builds a request with every frame in order and the chat", () => {
  const body = X.buildRequest(input, "claude-sonnet-5-5");
  assert.equal(body.model, "claude-sonnet-5-5");
  const blocks = body.messages[0].content;
  const images = blocks.filter((b) => b.type === "image");
  assert.deepEqual(images.map((b) => b.source.data), ["AAAA", "BBBB"]);
  assert.equal(images[0].source.media_type, "image/jpeg");
  const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  assert.match(text, /KAI VS SPEED/);
  assert.match(text, /Frame at 1:06:25/);
  assert.match(text, /\[1:06:41\] amy: LMAOOO/);
  assert.match(text, /Laughter 80%/);
  assert.match(text, /cannot hear audio/);
});

test("reads the model's JSON even with text around it, and cleans bad values", () => {
  const reply = (text) => ({ content: [{ type: "text", text }] });
  const good = X.parseResponse(reply('Sure:\n{"title":"Speed falls off the roof","what_happened":"x","why_chat_reacted":"y","trigger":"gameplay","cause_time":"1:06:30","confidence":"high","evidence":["frame 3"]}'));
  assert.equal(good.title, "Speed falls off the roof");
  assert.equal(good.triggerLabel, "Gameplay");
  assert.equal(good.confidence, "high");
  const odd = X.parseResponse(reply('{"trigger":"aliens","confidence":"certain","evidence":"nope"}'));
  assert.equal(odd.trigger, "unclear");
  assert.equal(odd.confidence, "low");
  assert.deepEqual(odd.evidence, []);
  assert.throws(() => X.parseResponse(reply("no json here")), /expected format/);
});

test("calls the Claude API with the browser headers and maps errors to readable messages", async () => {
  let seen;
  const ok = async (url, init) => {
    seen = { url, init };
    return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: '{"title":"t","trigger":"streamer","confidence":"medium","evidence":[]}' }] }) };
  };
  const result = await X.explain(input, { apiKey: "sk-ant-test", model: "claude-haiku-5-5", fetchImpl: ok });
  assert.equal(result.trigger, "streamer");
  assert.equal(result.provider, "anthropic");
  assert.equal(seen.url, "https://api.anthropic.com/v1/messages");
  assert.equal(seen.init.headers["x-api-key"], "sk-ant-test");
  assert.equal(seen.init.headers["anthropic-dangerous-direct-browser-access"], "true");
  assert.equal(JSON.parse(seen.init.body).model, "claude-haiku-5-5");

  const failing = (status, message = "nope") => async () => ({ ok: false, status, json: async () => ({ error: { message } }) });
  await assert.rejects(X.explain(input, { apiKey: "sk-ant-k", fetchImpl: failing(401) }), /key was rejected/);
  await assert.rejects(X.explain(input, { apiKey: "sk-ant-k", fetchImpl: failing(429) }), /Rate limited/);
  await assert.rejects(X.explain(input, { apiKey: "sk-ant-k", fetchImpl: failing(404) }), /Model not found/);
  await assert.rejects(X.explain(input, { apiKey: "", fetchImpl: ok }), /API key/);
  await assert.rejects(X.explain({ ...input, frames: [] }, { apiKey: "sk-ant-k", fetchImpl: ok }), /No frames/);
});

// ---------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------

test("works out the provider from the key", () => {
  assert.equal(X.detectProvider("AIzaSyExample"), "gemini");
  assert.equal(X.detectProvider("sk-ant-api03-x"), "anthropic");
  assert.equal(X.detectProvider("something-else"), "gemini");
  assert.equal(X.detectProvider(""), null);
});

test("ranks Gemini models: newest stable Flash first, skips non-vision kinds", () => {
  const models = [
    "gemini-2.5-flash", "gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite", "gemini-3-flash-preview",
    "gemini-3.1-flash-image", "gemini-3.1-flash-tts-preview", "gemini-3.1-flash-live-preview", "gemini-3.1-pro-preview",
    "gemini-embedding-001", "gemini-3.5-transcribe",
  ].map((id) => ({ name: `models/${id}`, supportedGenerationMethods: ["generateContent"] }));
  models.push({ name: "models/gemini-9.9-flash", supportedGenerationMethods: ["embedContent"] });
  assert.deepEqual(X.rankGeminiModels(models), [
    "gemini-3.7-flash", "gemini-3.6-flash", "gemini-2.5-flash", "gemini-3.5-flash-lite", "gemini-3-flash-preview",
  ]);
});

test("builds a Gemini request with inline JPEG frames and JSON output", () => {
  const body = X.buildGeminiRequest(input);
  const parts = body.contents[0].parts;
  assert.deepEqual(parts.filter((p) => p.inline_data).map((p) => p.inline_data.data), ["AAAA", "BBBB"]);
  assert.equal(parts.find((p) => p.inline_data).inline_data.mime_type, "image/jpeg");
  assert.equal(body.generationConfig.responseMimeType, "application/json");
  assert.match(parts.map((p) => p.text || "").join("\n"), /\[1:06:41\] amy: LMAOOO/);
});

const geminiReply = (text, extra = {}) => ({ candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP", ...extra }] });

test("reads Gemini replies and reports blocked or cut-off answers", () => {
  const ok = X.parseGeminiResponse(geminiReply('{"title":"Big clutch","trigger":"gameplay","confidence":"high","evidence":["x"]}'));
  assert.equal(ok.title, "Big clutch");
  assert.equal(ok.triggerLabel, "Gameplay");
  const withThought = X.parseGeminiResponse({ candidates: [{ content: { parts: [{ text: "thinking {not json", thought: true }, { text: '{"title":"T"}' }] } }] });
  assert.equal(withThought.title, "T");
  assert.throws(() => X.parseGeminiResponse({ promptFeedback: { blockReason: "SAFETY" } }), /declined.*SAFETY/);
  assert.throws(() => X.parseGeminiResponse({ candidates: [{ content: { parts: [] }, finishReason: "MAX_TOKENS" }] }), /stopped early/);
});

/** A fake Gemini API: lists models, and some models have no free quota. */
function fakeGemini({ models, noFreeQuota = [], listFails = false }) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
    if (url.includes("/models?")) {
      if (listFails) return json(500, { error: { message: "boom" } });
      return json(200, { models: models.map((id) => ({ name: `models/${id}`, supportedGenerationMethods: ["generateContent"] })) });
    }
    const model = decodeURIComponent(url.match(/models\/([^:]+):generateContent/)[1]);
    if (init.headers["x-goog-api-key"] === "AIzaBAD") return json(400, { error: { message: "API key not valid. Please pass a valid API key." } });
    if (noFreeQuota.includes(model)) return json(429, { error: { message: `Quota exceeded for metric: generate_content_free_tier_requests, limit: 0, model: ${model}` } });
    if (!models.includes(model)) return json(404, { error: { message: `models/${model} is not found` } });
    return json(200, geminiReply(`{"title":"from ${model}","trigger":"gameplay","confidence":"medium","evidence":[]}`));
  };
  return { fetchImpl, calls };
}

test("Gemini: picks the best model automatically and remembers it", async () => {
  const api = fakeGemini({ models: ["gemini-2.5-flash", "gemini-3.6-flash", "gemini-3.1-flash-image"] });
  const ex = X.createExplainer({ apiKey: "AIzaTest", fetchImpl: api.fetchImpl });
  assert.equal(ex.provider, "gemini");
  const first = await ex.explain(input);
  assert.equal(first.model, "gemini-3.6-flash");
  assert.equal(first.title, "from gemini-3.6-flash");
  assert.equal(api.calls[0].init.headers["x-goog-api-key"], "AIzaTest");
  await ex.explain(input);
  assert.equal(api.calls.filter((c) => c.url.includes("/models?")).length, 1); // listed once
});

test("Gemini: moves to the next model when one has no free quota", async () => {
  const api = fakeGemini({ models: ["gemini-3.7-flash", "gemini-3.6-flash"], noFreeQuota: ["gemini-3.7-flash"] });
  const ex = X.createExplainer({ apiKey: "AIzaTest", fetchImpl: api.fetchImpl });
  const result = await ex.explain(input);
  assert.equal(result.model, "gemini-3.6-flash");
  assert.equal(ex.model, "gemini-3.6-flash");
});

test("Gemini: uses built-in model names if the list can't be fetched", async () => {
  const api = fakeGemini({ models: ["gemini-2.5-flash"], listFails: true });
  const result = await X.createExplainer({ apiKey: "AIzaTest", fetchImpl: api.fetchImpl }).explain(input);
  assert.equal(result.model, "gemini-2.5-flash"); // walked the fallback list past models that 404
});

test("Gemini: a bad key or an explicit missing model gives a clear error", async () => {
  const api = fakeGemini({ models: ["gemini-3.6-flash"] });
  await assert.rejects(X.createExplainer({ apiKey: "AIzaBAD", fetchImpl: api.fetchImpl }).explain(input), /key was rejected/);
  await assert.rejects(X.createExplainer({ apiKey: "AIzaTest", model: "gemini-0-flash", fetchImpl: api.fetchImpl }).explain(input), /Model not found/);
});

// ---------------------------------------------------------------------------
// Busy models ("high demand", "overloaded")
// ---------------------------------------------------------------------------

/** A fake Gemini where some models answer "high demand" a number of times. */
function busyGemini({ models, busy = {} }) {
  const calls = [];
  const left = { ...busy };
  const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
  const fetchImpl = async (url) => {
    if (url.includes("/models?")) return json(200, { models: models.map((id) => ({ name: `models/${id}`, supportedGenerationMethods: ["generateContent"] })) });
    const model = decodeURIComponent(url.match(/models\/([^:]+):generateContent/)[1]);
    calls.push(model);
    if (left[model] === Infinity || left[model] > 0) {
      left[model] -= 1;
      return json(503, { error: { code: 503, status: "UNAVAILABLE", message: "This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later." } });
    }
    return json(200, { candidates: [{ content: { parts: [{ text: `{"title":"from ${model}","trigger":"gameplay","confidence":"high","evidence":[]}` }] }, finishReason: "STOP" }] });
  };
  return { fetchImpl, calls };
}

test("a busy model is retried after a pause and then works", async () => {
  const api = busyGemini({ models: ["gemini-3.6-flash"], busy: { "gemini-3.6-flash": 1 } });
  const pauses = [];
  const statuses = [];
  const ex = X.createExplainer({ apiKey: "AIzaT", fetchImpl: api.fetchImpl, sleep: async (ms) => pauses.push(ms), onStatus: (t) => statuses.push(t) });
  const result = await ex.explain(input);
  assert.equal(result.model, "gemini-3.6-flash");
  assert.deepEqual(api.calls, ["gemini-3.6-flash", "gemini-3.6-flash"]);
  assert.deepEqual(pauses, [2000]);
  assert.match(statuses[0], /busy, trying again in 2s/);
});

test("a model that stays busy is swapped for the next one, which is remembered", async () => {
  const api = busyGemini({ models: ["gemini-3.7-flash", "gemini-3.6-flash"], busy: { "gemini-3.7-flash": Infinity } });
  const statuses = [];
  const ex = X.createExplainer({ apiKey: "AIzaT", fetchImpl: api.fetchImpl, sleep: async () => {}, onStatus: (t) => statuses.push(t) });
  const first = await ex.explain(input);
  assert.equal(first.model, "gemini-3.6-flash");
  assert.deepEqual(api.calls, ["gemini-3.7-flash", "gemini-3.7-flash", "gemini-3.7-flash", "gemini-3.6-flash"]);
  assert.ok(statuses.some((t) => /switching to gemini-3.6-flash/.test(t)));
  await ex.explain(input);
  assert.equal(api.calls.at(-1), "gemini-3.6-flash"); // goes straight to the one that worked
  assert.equal(api.calls.length, 5);
});

test("when every model is busy, one clear error stops Explain all", async () => {
  const api = busyGemini({ models: ["gemini-3.7-flash", "gemini-3.6-flash"], busy: { "gemini-3.7-flash": Infinity, "gemini-3.6-flash": Infinity } });
  await assert.rejects(
    X.createExplainer({ apiKey: "AIzaT", fetchImpl: api.fetchImpl, sleep: async () => {} }).explain(input),
    (error) => error.fatal && error.busy && /overloaded on every model/.test(error.message),
  );
  assert.equal(api.calls.length, 6); // 3 tries on each model
});

test("Claude 'overloaded' is retried too", async () => {
  let n = 0;
  const fetchImpl = async () => {
    n += 1;
    if (n === 1) return { ok: false, status: 529, json: async () => ({ error: { type: "overloaded_error", message: "Overloaded" } }) };
    return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: '{"title":"ok","trigger":"gameplay","confidence":"high","evidence":[]}' }] }) };
  };
  const result = await X.createExplainer({ apiKey: "sk-ant-x", fetchImpl, sleep: async () => {} }).explain(input);
  assert.equal(result.title, "ok");
  assert.equal(n, 2);
});
