// Run with: node --test tests/
const test = require("node:test");
const assert = require("node:assert/strict");
const A = require("../frontend/analysis.js");
const { generateSampleChat, EVENTS } = require("../frontend/sample.js");

test("parseTime handles seconds, clocks and ISO durations", () => {
  assert.equal(A.parseTime(42), 42);
  assert.equal(A.parseTime("1:02:03"), 3723);
  assert.equal(A.parseTime("2:05"), 125);
  assert.equal(A.parseTime("PT1H2M3.5S"), 3723.5);
  assert.ok(Number.isNaN(A.parseTime("")));
});

test("parses CSV with quoted commas and drops empty rows", () => {
  const csv = 'Timestamp,Author,Message\n0:05,amy,hello\n0:01,bob,"hi, ""chat"""\n0:09,cat,\n';
  const messages = A.parseChatExport(csv, "chat.csv");
  assert.deepEqual(messages.map((m) => m.text), ['hi, "chat"', "hello"]);
  assert.equal(messages[0].author, "bob");
});

test("parses TwitchDownloader JSON", () => {
  const raw = JSON.stringify({ comments: [
    { content_offset_seconds: 9, commenter: { display_name: "Amy" }, message: { body: "POG" } },
    { content_offset_seconds: 2, commenter: { display_name: "Bob" }, message: { body: "hi" } },
  ] });
  const messages = A.parseChatExport(raw, "vod.json");
  assert.deepEqual(messages.map((m) => [m.timestamp, m.author, m.text]), [[2, "Bob", "hi"], [9, "Amy", "POG"]]);
});

test("parses chat-downloader newline-delimited JSON and skips pre-stream messages", () => {
  const raw = [
    { time_in_seconds: -5, message: "waiting", author: { name: "Early" } },
    { time_in_seconds: 3.5, message: "hello", author: { name: "Amy" } },
  ].map((r) => JSON.stringify(r)).join("\n");
  const messages = A.parseChatExport(raw, "yt.json");
  assert.deepEqual(messages.map((m) => [m.timestamp, m.author]), [[3.5, "Amy"]]);
});

test("throws a readable error for files with no messages", () => {
  assert.throws(() => A.parseChatExport("[]", "x.json"), /No messages/);
  assert.throws(() => A.parseChatExport("not json", "x.json"), SyntaxError);
});

test("finds every planted event in the sample stream", () => {
  const messages = A.parseChatExport(JSON.stringify(generateSampleChat()), "sample.json");
  const { moments } = A.findMoments(messages);
  assert.equal(moments.length, EVENTS.length);
  for (const event of EVENTS) {
    const hit = moments.find((m) => m.windowStart <= event.at + 15 && m.windowEnd >= event.at);
    assert.ok(hit, `missed ${event.label} at ${A.clock(event.at)}`);
  }
  assert.deepEqual(moments.map((m) => m.rank), moments.map((_, i) => i + 1));
});

test("sensitivity presets change how many moments are found", () => {
  const messages = A.parseChatExport(JSON.stringify(generateSampleChat()), "sample.json");
  const count = (z) => A.findMoments(messages, { zThreshold: z }).moments.length;
  assert.ok(count(A.SENSITIVITY.low) < count(A.SENSITIVITY.medium));
  assert.ok(count(A.SENSITIVITY.medium) <= count(A.SENSITIVITY.high));
});

test("rejects invalid settings", () => {
  const messages = [{ timestamp: 1, text: "hi", author: "a" }];
  assert.throws(() => A.findMoments(messages, { windowSeconds: 0 }));
  assert.throws(() => A.findMoments(messages, { minMessages: 0 }));
  assert.throws(() => A.findMoments(messages, { zThreshold: -1 }));
});

test("clock formats short and long times", () => {
  assert.equal(A.clock(5), "0:05");
  assert.equal(A.clock(754), "12:34");
  assert.equal(A.clock(3723.9), "1:02:03");
});

test("extracts IDs from Twitch and YouTube links", () => {
  assert.deepEqual(A.extractVideoId("https://www.twitch.tv/videos/2290000001?t=1h"), { platform: "twitch", videoId: "2290000001" });
  assert.deepEqual(A.extractVideoId("https://www.youtube.com/watch?v=abcDEF12345&t=3s"), { platform: "youtube", videoId: "abcDEF12345" });
  assert.deepEqual(A.extractVideoId("https://youtu.be/abcDEF12345"), { platform: "youtube", videoId: "abcDEF12345" });
  assert.deepEqual(A.extractVideoId("https://www.youtube.com/live/abcDEF12345"), { platform: "youtube", videoId: "abcDEF12345" });
  assert.deepEqual(A.extractVideoId("12345"), { platform: null, videoId: "12345" });
});

test("builds VOD links that open at the moment", () => {
  assert.equal(A.vodLink("twitch", "123", 3723), "https://www.twitch.tv/videos/123?t=1h2m3s");
  assert.equal(A.vodLink("youtube", "abc", 90.7), "https://www.youtube.com/watch?v=abc&t=90s");
  assert.equal(A.vodLink("twitch", "", 10), null);
});

test("CSV and chapter exports", () => {
  const moments = [
    { rank: 1, timestamp: 600, messageCount: 50, peakCount: 30, intensity: 9, zScore: 7, keywords: ["boss", "down"], note: 'Boss, "finally"' },
    { rank: 2, timestamp: 60, messageCount: 20, peakCount: 12, intensity: 4, zScore: 3, keywords: ["raid"], note: "" },
  ];
  const csv = A.toCsv(moments, "twitch", "123").split("\n");
  assert.equal(csv.length, 3);
  assert.match(csv[1], /^1,10:00,600,50,30,9,7,boss \| down,https:\/\/www\.twitch\.tv\/videos\/123\?t=0h10m0s,"Boss, ""finally"""$/);
  assert.equal(A.toChapters(moments), '1:00 raid\n10:00 Boss, "finally"');
});
