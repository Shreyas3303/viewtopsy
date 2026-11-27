// Run with: npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const A = require("../frontend/analysis.js");
const R = require("../frontend/reactions.js");
const I = require("../frontend/insights.js");
const { ViewtopsyFrames: F } = require("../frontend/frames.js");

const msg = (timestamp, text = "chat", author = `u${Math.floor(timestamp * 7) % 50}`) => ({ timestamp, text, author });

/** Steady chat (one message every `every` seconds) between `from` and `to`. */
function steady(from, to, every = 3, text = "chat") {
  const out = [];
  for (let t = from; t < to; t += every) out.push(msg(t, text));
  return out;
}
const burst = (at, count, text, spread = 0.5) => Array.from({ length: count }, (_, i) => msg(at + i * spread, text, `fan${i}`));
const sorted = (list) => list.sort((a, b) => a.timestamp - b.timestamp);

// ---------------------------------------------------------------------------
// Where chat starts rising, and which frames get captured
// ---------------------------------------------------------------------------

test("finds where chat starts rising before the peak", () => {
  const messages = sorted([...steady(0, 600, 3), ...burst(300, 12, "oh", 1.2), ...burst(315, 40, "NO WAY", 0.3)]);
  const { moments } = A.findMoments(messages, { zThreshold: 2 });
  assert.equal(moments.length, 1);
  assert.equal(moments[0].onsetTime, 300); // the build-up window
  assert.ok(moments[0].peakTime >= 315);
});

test("frames run from 25s before chat rises to the end of that window, tightest near the rise", () => {
  const times = F.frameTimes(300, 15);
  assert.equal(times.length, 8);
  assert.equal(times[0], 275);
  assert.equal(Math.round(times[7]), 312);
  const gaps = times.slice(1).map((t, i) => t - times[i]);
  assert.ok(gaps[0] > gaps[gaps.length - 1] * 3, "early gaps are wider than late ones");
});

// ---------------------------------------------------------------------------
// Spike types
// ---------------------------------------------------------------------------

test("labels organic, prompted, alert and copypasta spikes", () => {
  const kind = (texts) => {
    const messages = texts.map((text, i) => msg(i, text, `a${i}`));
    return I.momentKind(messages, R.profile(messages)).id;
  };
  assert.equal(kind(["KEKW", "LMAO", "KEKW", "he fell", "LUL", "lol", "omg"]), "organic");
  assert.equal(kind(["yes", "YES", "no", "NOOO", "its good", "yes", "1", "2"]), "prompted");
  assert.equal(kind(["thank you for the gifted subs", "gifted!", "raid hype", "welcome raiders", "hype train", "W"]), "alert");
  const pasta = "this is the greatest stream in the history of streams";
  assert.equal(kind([pasta, pasta, pasta, pasta, pasta, pasta, "lol", "W", "true"]), "copypasta");
  assert.equal(kind(["hi", "hello", "gn", "bye", "o7", "hey"]), "greeting");
});

// ---------------------------------------------------------------------------
// Quiet stretches
// ---------------------------------------------------------------------------

test("finds a long quiet stretch and ignores short dips", () => {
  const messages = sorted([
    ...steady(0, 1200, 2),
    ...steady(1200, 1500, 20, "anyone here?"), // 5 minutes nearly silent
    ...steady(1500, 2400, 2),
    ...steady(1800, 1860, 20), // only a 1-minute dip (still covered by steady chat above)
  ]);
  const result = A.findMoments(messages);
  const quiet = I.findQuietStretches(messages, result, { windowSeconds: 15 });
  assert.equal(quiet.length, 1);
  assert.ok(Math.abs(quiet[0].start - 1200) <= 60, `starts near 20:00, got ${quiet[0].start}`);
  assert.ok(quiet[0].duration >= 240);
  assert.ok(quiet[0].pace < 0.3);
  assert.equal(quiet[0].nearEdge, false);
  assert.equal(quiet[0].samples[0].text, "anyone here?");
});

test("steady chat has no quiet stretches", () => {
  const messages = steady(0, 1800, 2);
  assert.deepEqual(I.findQuietStretches(messages, A.findMoments(messages)), []);
});

// ---------------------------------------------------------------------------
// Segments
// ---------------------------------------------------------------------------

test("scores segments by chapter when the export has them", () => {
  const messages = sorted([...steady(0, 600, 6), ...steady(600, 1200, 2)]);
  const result = A.findMoments(messages);
  const chapters = [{ start: 0, end: 600, title: "Just Chatting" }, { start: 600, end: 5000, title: "GTA VI" }];
  const { basis, segments } = I.segmentScores(messages, result, { chapters });
  assert.equal(basis, "chapters");
  assert.deepEqual(segments.map((s) => s.title), ["Just Chatting", "GTA VI"]);
  assert.ok(segments[1].relative > 2 * segments[0].relative);
  assert.equal(segments[1].end, 1199); // clipped to just after the last message
});

test("falls back to time blocks without chapters", () => {
  const messages = steady(3600, 5400, 3);
  const { basis, segments } = I.segmentScores(messages, A.findMoments(messages), { chapters: [{ start: 0, end: 99999, title: "One" }] });
  assert.equal(basis, "time");
  assert.equal(segments.length, 6); // 30 minutes in 5-minute blocks
  assert.equal(segments[0].title, "1:00:00–1:05:00");
});

// ---------------------------------------------------------------------------
// Existing clips
// ---------------------------------------------------------------------------

const helixClips = {
  data: [
    { id: "BigClip", url: "https://clips.twitch.tv/BigClip", title: "SPEED SCREAMS", view_count: 12000, vod_offset: 4990, duration: 30, video_id: "2939504732", creator_name: "fan" },
    { id: "Other", title: "calm moment", view_count: 300, vod_offset: 4200, duration: 20, video_id: "2939504732" },
    { id: "NoOffset", title: "deleted vod", view_count: 5, vod_offset: null, duration: 20, video_id: "2939504732" },
    { id: "OtherVod", title: "elsewhere", view_count: 5, vod_offset: 10, duration: 20, video_id: "111" },
  ],
};

test("reads clips files and keeps only clips placed in this VOD", () => {
  const clips = I.parseClips(JSON.stringify(helixClips), "2939504732");
  assert.deepEqual(clips.map((c) => c.id), ["Other", "BigClip"]);
  assert.equal(clips[1].views, 12000);
  assert.deepEqual(I.parseClips([{ id: "x", vod_offset: 5 }]).map((c) => c.duration), [30]);
});

test("matches clips to moments and finds unclipped ones", () => {
  const clips = I.parseClips(helixClips, "2939504732");
  const moments = [
    { windowStart: 5010, windowEnd: 5040, onsetTime: 5010 }, // clipped by BigClip (starts 20s before the rise)
    { windowStart: 3700, windowEnd: 3715, onsetTime: 3700 }, // nobody clipped
  ];
  const { byMoment, unmatched } = I.matchClips(moments, clips);
  assert.deepEqual(byMoment.get(5010).map((c) => c.id), ["BigClip"]);
  assert.deepEqual(byMoment.get(3700), []);
  assert.deepEqual(unmatched.map((c) => c.id), ["Other"]);
});

// ---------------------------------------------------------------------------
// Editor markers
// ---------------------------------------------------------------------------

const exportMoments = [
  { rank: 1, timestamp: 5280, windowEnd: 5310, intensity: 3.3, reaction: "Mostly laughter", keywords: ["banks"], kind: { id: "organic", label: "Organic reaction" }, ai: { title: "Heist <fails> & chat \"dies\"", whatHappened: "x" }, clips: [] },
  { rank: 2, timestamp: 3780, windowEnd: 3810, intensity: 3.1, reaction: "Chat voting", keywords: ["yes"], kind: { id: "prompted", label: "Prompted" }, note: "Poll | pick" },
  { rank: 3, timestamp: 100, windowEnd: 115, intensity: 2, keywords: [] }, // before the video starts: skipped
];

test("timecodes", () => {
  assert.equal(I.timecode(0, 30), "00:00:00:00");
  assert.equal(I.timecode(61.5, 30), "00:01:01:15");
  assert.equal(I.timecode(5, 25, 1), "01:00:05:00");
});

test("Resolve EDL markers are relative to the video file and in time order", () => {
  const edl = I.toResolveEdl(exportMoments, { videoOffset: 3600, fps: 30 });
  const lines = edl.split("\n");
  assert.equal(lines[0], "TITLE: Viewtopsy markers");
  const events = lines.filter((l) => /^\d{3} /.test(l));
  assert.equal(events.length, 2);
  assert.match(events[0], /^001 +001 +V +C +01:03:00:00 01:03:00:01 01:03:00:00 01:03:00:01/);
  assert.match(edl, / \|C:ResolveColorBlue \|M:Poll pick \|D:900/);
  assert.match(edl, / \|C:ResolveColorRed \|M:Heist <fails> & chat "dies" \|D:900/);
});

test("Premiere XML has escaped markers at frame positions", () => {
  const out = I.toPremiereXml(exportMoments, { videoOffset: 3600, fps: 30, videoName: "kai clip.mp4", videoDuration: 1810 });
  assert.match(out, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<!DOCTYPE xmeml>/);
  assert.equal((out.match(/<marker>/g) || []).length, 2);
  assert.match(out, /<name>#1 Heist &lt;fails&gt; &amp; chat &quot;dies&quot;<\/name>/);
  assert.match(out, /<in>50400<\/in>\s*<out>51300<\/out>/); // (5280-3600)*30 .. (5310-3600)*30
  assert.match(out, /<pathurl>file:\/\/localhost\/kai%20clip.mp4<\/pathurl>/);
  assert.match(out, /<duration>54300<\/duration>/);
  assert.match(out, /Not clipped yet/);
});

// ---------------------------------------------------------------------------
// Reaction lag
// ---------------------------------------------------------------------------

test("measures how long chat takes to react from AI cause times", () => {
  const m = (onsetTime, causeTime, confidence = "high") => ({ onsetTime, windowSeconds: 15, ai: { causeTime, confidence } });
  const lag = I.reactionLag([
    m(5280, "1:27:55"), // 5287.5 - 5275 = 12.5
    m(3780, "1:02:52"), // 3787.5 - 3772 = 15.5
    m(4425, "1:13:39"), // 4432.5 - 4419 = 13.5
    m(1000, "0:10:00", "low"), // ignored: low confidence
    m(2000, "nonsense"), // ignored: unreadable
    m(3000, "0:20:00"), // ignored: 1807s is implausible
  ]);
  assert.deepEqual(lag, { count: 3, median: 14, min: 13, max: 16 });
  assert.equal(I.reactionLag([]), null);
});
