// Run with: npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const A = require("../frontend/analysis.js");
const R = require("../frontend/reactions.js");
const I = require("../frontend/insights.js");

const msg = (timestamp, text = "chat", author = `u${timestamp}`, extra = {}) => ({ timestamp, text, author, sub: false, bits: 0, paid: false, ...extra });
const steady = (from, to, every = 3) => Array.from({ length: Math.ceil((to - from) / every) }, (_, i) => msg(from + i * every, "chat", `reg${i % 20}`));
const sorted = (list) => list.sort((a, b) => a.timestamp - b.timestamp);

// A 30-minute stream; at 20:00 a 40-second hype wave from mostly new chatters.
function hypeStream() {
  const wave = Array.from({ length: 80 }, (_, i) => msg(1200 + i * 0.5, i % 10 === 0 ? "CLIP IT" : "NO WAY", `new${i}`, { sub: i % 2 === 0, bits: i === 3 ? 500 : 0 }));
  return sorted([...steady(0, 1800, 3), ...wave]);
}

test("reads subscriber, bits and paid flags from each format", () => {
  const twitch = A.normalizeRow({ content_offset_seconds: 5, commenter: { display_name: "A" }, message: { body: "Cheer100 nice", bits_spent: 0, user_badges: [{ _id: "subscriber" }] } });
  assert.deepEqual([twitch.sub, twitch.bits, twitch.paid], [true, 100, false]);
  assert.equal(A.normalizeRow({ content_offset_seconds: 5, message: { body: "I have 100 subs", user_badges: [{ _id: "founder" }] } }).bits, 0);
  assert.equal(A.normalizeRow({ content_offset_seconds: 5, message: { body: "x", user_badges: [{ _id: "founder" }] } }).sub, true);
  const yt = A.normalizeRow({ time_in_seconds: 3, message: "hi", author: { name: "B", badges: [{ title: "Member (1 year)" }] }, message_type: "paid_message" });
  assert.deepEqual([yt.sub, yt.paid], [true, true]);
  const csv = A.normalizeRow({ timestamp: "0:05", message: "x", subscriber: "true", bits: "50" });
  assert.deepEqual([csv.sub, csv.bits], [true, 50]);
});

test("moment signals: hype length, first-time chatters, clip requests, audience", () => {
  const messages = hypeStream();
  const result = A.findMoments(messages);
  assert.equal(result.moments.length, 1);
  const m = result.moments[0];
  const s = I.momentSignals(m, messages, result, { seen: I.firstSeen(messages), streamSubShare: 0.05 });
  assert.ok(s.hype.duration >= 30 && s.hype.duration <= 75, `hype ${s.hype.duration}s`);
  assert.equal(s.firstTimers, 80);
  assert.ok(s.firstTimerShare > 0.7);
  assert.equal(s.clipRequests, 8);
  assert.ok(s.audience.subShare > 0.35);
  assert.equal(s.audience.bits, 500);
});

test("first-time chatters aren't counted in the first 10 minutes of the chat", () => {
  const wave = Array.from({ length: 60 }, (_, i) => msg(300 + i * 0.5, "W", `new${i}`));
  const messages = sorted([...steady(0, 1800, 3), ...wave]);
  const result = A.findMoments(messages);
  assert.equal(I.momentSignals(result.moments[0], messages, result, { seen: I.firstSeen(messages) }).firstTimers, null);
});

test("clip range: from a bit before the rise, or from the AI's cause, to after chat calms", () => {
  const moment = { onsetTime: 1200, peakTime: 1215, windowStart: 1200, windowEnd: 1230, windowSeconds: 15 };
  const signals = { hype: { end: 1245 } };
  assert.deepEqual(I.clipRange(moment, signals), { in: 1190, out: 1248, length: 58, fromAi: false });
  const ai = { causeTime: "0:19:52", confidence: "high" }; // 1192
  assert.deepEqual(I.clipRange(moment, signals, ai), { in: 1188, out: 1248, length: 60, fromAi: true });
  assert.equal(I.clipRange(moment, signals, { causeTime: "0:05:00", confidence: "high" }).fromAi, false); // implausible
  assert.equal(I.clipRange(moment, signals, { causeTime: "0:19:52", confidence: "low" }).fromAi, false);
  assert.equal(I.clipRange(moment, { hype: { end: 1500 } }).length, 90); // capped
});

test("clip score prefers organic, broad, unclipped moments and explains why", () => {
  const base = { zScore: 5, signals: { chatters: 100, firstTimers: 40, firstTimerShare: 0.4, clipRequests: 4 } };
  const scores = I.clipScores([
    { ...base, windowStart: 1, kind: { id: "organic", label: "Organic reaction" }, clips: [] },
    { ...base, windowStart: 2, kind: { id: "prompted", label: "Prompted" }, clips: [] },
    { ...base, windowStart: 3, kind: { id: "organic", label: "Organic reaction" }, clips: [{ id: "c" }] },
    { zScore: 2, windowStart: 4, signals: { chatters: 20, firstTimerShare: 0, clipRequests: 0 }, kind: { id: "organic" }, clips: [] },
  ]);
  const s = (k) => scores.get(k).score;
  assert.ok(s(1) > s(3) && s(3) > s(2), `${s(1)} ${s(3)} ${s(2)}`);
  assert.ok(s(1) > s(4));
  assert.ok(s(1) <= 100);
  assert.deepEqual(scores.get(1).reasons, ["one of the biggest spikes", "100 people reacted", "40 first-time chatters", "chat asked for a clip 4×", "nobody has clipped it"]);
  assert.match(scores.get(2).reasons.at(-1), /prompted, so ranked lower/);
});

test("mood timeline picks the main reaction per bucket, or none", () => {
  const messages = sorted([
    ...Array.from({ length: 10 }, (_, i) => msg(i, "KEKW")),
    ...Array.from({ length: 10 }, (_, i) => msg(60 + i, "NO WAY")),
    ...Array.from({ length: 10 }, (_, i) => msg(120 + i, "what game is this")),
  ]);
  const rows = I.moodTimeline(messages, { start: 0, end: 180, bucket: 60 }, R.profile);
  assert.deepEqual(rows.map((r) => r.mood), ["laughter", "shock", null]);
  assert.deepEqual(rows.map((r) => r.count), [10, 10, 10]);
  assert.equal(I.moodBucket(1800), 30);
  assert.equal(I.moodBucket(5 * 3600), 210);
});

test("chat search: whole words for short queries, authors too, special characters are safe", () => {
  const messages = [msg(1, "W"), msg(2, "W landing"), msg(3, "wow nice"), msg(4, "ramen tier list", "gigguk"), msg(5, "1+1=2"), msg(6, "hi", "RamenFan")];
  assert.equal(I.searchChat(messages, "w").total, 2);
  assert.equal(I.searchChat(messages, "ramen").total, 2); // message + author
  assert.equal(I.searchChat(messages, "1+1").total, 1);
  assert.equal(I.searchChat(messages, "  ").total, 0);
  const limited = I.searchChat(messages, "w", { limit: 1 });
  assert.equal(limited.matches.length, 1);
  assert.deepEqual(limited.times, [1, 2]); // the chart still gets every match
});

test("editor markers span the suggested clip range", () => {
  const m = { rank: 1, timestamp: 1200, windowEnd: 1230, intensity: 3, keywords: ["x"], clipRange: { in: 1190, out: 1250 }, clipScore: 77 };
  const edl = I.toResolveEdl([m], { videoOffset: 0, fps: 30, startHour: 1 });
  assert.match(edl, /01:19:50:00/);
  assert.match(edl, /\|D:1800/);
  const xml = I.toPremiereXml([m], { videoOffset: 0, fps: 30 });
  assert.match(xml, /<in>35700<\/in>\s*<out>37500<\/out>/);
  assert.match(xml, /clip score 77/);
});

test("stream overview: hype time, clip requests with and without spikes, new-chatter waves, money", () => {
  const msgs = sorted([
    ...steady(0, 2400, 3),
    // a hype wave at 20:00 from new people, two of them asking for a clip
    ...Array.from({ length: 80 }, (_, i) => msg(1200 + i * 0.5, i < 2 ? "CLIP IT" : "NO WAY", `wave${i}`, { bits: i === 5 ? 300 : 0 })),
    // chat asks for a clip at 30:00 without spiking
    msg(1800, "clip that", "reg1"), msg(1805, "!clip", "reg2"),
    // 40 new people arrive during minute 35 (in steady chat that's also a small spike)
    ...Array.from({ length: 40 }, (_, i) => msg(2100 + i * 1.4, "hi", `raider${i}`)),
    msg(2300, "great stream", "fan", { paid: true }),
  ]);
  const result = A.findMoments(msgs);
  const seen = I.firstSeen(msgs);
  const moments = result.moments.map((m) => ({ ...m, signals: I.momentSignals(m, msgs, result, { seen }) }));
  const o = I.streamOverview(msgs, result, moments);

  assert.equal(o.messages, msgs.length);
  assert.ok(o.hype.seconds >= 30 && o.hype.seconds <= 120);
  assert.equal(o.hype.longest.duration, Math.max(...moments.map((m) => m.signals.hype.duration)));

  assert.equal(o.clipRequests.total, 4);
  assert.equal(o.clipRequests.groups.length, 2);
  assert.equal(o.clipRequests.groups[0].momentRank, 1);
  assert.deepEqual(o.clipRequests.withoutSpike.map((g) => g.start), [1800]);

  const waves = o.newChatters.waves.map((w) => [w.start, w.momentRank]);
  assert.deepEqual(waves.find((w) => w[0] === 1200), [1200, 1]);
  assert.ok(waves.some((w) => w[0] === 2100 && w[1] === 2), JSON.stringify(waves));

  assert.equal(o.audience.bits, 300);
  assert.equal(o.audience.paid, 1);
  assert.equal(o.audience.moneyMoments[0].bits, 300);
});
