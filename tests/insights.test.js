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
    clipStart: 3600, clipEnd: 5400, streamLength: 17889,
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

test("calls the API with the browser headers and maps errors to readable messages", async () => {
  let seen;
  const ok = async (url, init) => {
    seen = { url, init };
    return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: '{"title":"t","trigger":"streamer","confidence":"medium","evidence":[]}' }] }) };
  };
  const result = await X.explain(input, { apiKey: "sk-test", model: "claude-haiku-5-5", fetchImpl: ok });
  assert.equal(result.trigger, "streamer");
  assert.equal(seen.url, "https://api.anthropic.com/v1/messages");
  assert.equal(seen.init.headers["x-api-key"], "sk-test");
  assert.equal(seen.init.headers["anthropic-dangerous-direct-browser-access"], "true");
  assert.equal(JSON.parse(seen.init.body).model, "claude-haiku-5-5");

  const failing = (status) => async () => ({ ok: false, status, json: async () => ({ error: { message: "nope" } }) });
  await assert.rejects(X.explain(input, { apiKey: "k", fetchImpl: failing(401) }), /key was rejected/);
  await assert.rejects(X.explain(input, { apiKey: "k", fetchImpl: failing(429) }), /Rate limited/);
  await assert.rejects(X.explain(input, { apiKey: "k", fetchImpl: failing(404) }), /Model not found/);
  await assert.rejects(X.explain(input, { apiKey: "", fetchImpl: ok }), /API key/);
  await assert.rejects(X.explain({ ...input, frames: [] }, { apiKey: "k", fetchImpl: ok }), /No frames/);
});
