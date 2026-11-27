/*
 * Generates a made-up but realistic-looking chat replay for the demo button.
 * It is deterministic (seeded), so the demo looks the same every time.
 * All usernames and messages are invented.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.ViewtopsySample = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function seededRandom(seed) {
    let state = seed >>> 0;
    return function next() {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const NAME_PARTS = [
    ["pixel", "night", "salty", "cozy", "turbo", "lunar", "frost", "mango", "quiet", "rapid", "ghost", "spicy"],
    ["fox", "otter", "wizard", "noodle", "panda", "raven", "goblin", "llama", "comet", "badger", "toast", "kraken"],
  ];

  const IDLE_CHAT = [
    "what game is this", "hi chat", "how long has stream been going", "this music is nice",
    "first time catching a stream live", "gg", "what rank are you", "hydrate", "o7",
    "love the new overlay", "is this ranked", "chat is so chill today", "back from dinner what did i miss",
    "that build looks strong", "what sens do you use", "lurking", "nice", "true", "lol",
    "hello from germany", "this map is so pretty", "take your time", "big brain", "the vibes are immaculate",
  ];

  // Each event is a burst of excited chat: when it happens, how big, what people say.
  const EVENTS = [
    { at: 6 * 60 + 40, seconds: 35, rate: 2.6, label: "Raid", lines: ["RAID HYPE", "hello from the raid!", "raid train choo choo", "welcome raiders", "PogChamp raid", "we're here from the raid"] },
    { at: 18 * 60 + 5, seconds: 25, rate: 3.4, label: "Jump scare", lines: ["KEKW", "HE SCREAMED", "LMAOOO", "the jump scare got him", "monkaS", "i jumped too", "CLIP IT", "his face KEKW"] },
    { at: 31 * 60 + 50, seconds: 30, rate: 2.2, label: "Big donation", lines: ["thank you for the 50 gifted!", "W donation", "gifted sub hype", "PogChamp gifts", "generous king", "W W W"] },
    { at: 47 * 60 + 20, seconds: 40, rate: 4.2, label: "Clutch 1v4", lines: ["NO WAY", "1V4 CLUTCH", "CLIP THAT", "POGGERS", "he's actually insane", "HOW", "best play of the year", "W streamer", "clutch god"] },
    { at: 63 * 60 + 10, seconds: 25, rate: 2.0, label: "Fail", lines: ["KEKW", "he fell off the map", "LUL", "not like this", "that was painful", "Sadge", "unlucky"] },
    { at: 78 * 60 + 30, seconds: 30, rate: 2.4, label: "Rare drop", lines: ["LEGENDARY", "no way it dropped", "rare drop PogChamp", "the RNG", "lucky", "finally the drop"] },
    { at: 96 * 60 + 15, seconds: 50, rate: 3.6, label: "Boss down", lines: ["BOSS DOWN", "FINALLY", "GG", "first try (after 40 tries)", "W W W", "PogChamp", "CLIP IT", "he did it"] },
    { at: 112 * 60 + 40, seconds: 20, rate: 1.8, label: "Hot take", lines: ["NOOO", "that take is wild", "chat is fighting", "LMAO", "ratio", "controversial"] },
    { at: 124 * 60 + 5, seconds: 30, rate: 2.2, label: "Goodbye", lines: ["gn", "great stream", "o7", "bye!", "thanks for streaming", "see you tomorrow", "gg"] },
  ];

  const STREAM_SECONDS = 127 * 60;

  function generateSampleChat(seed = 42) {
    const random = seededRandom(seed);
    const pick = (list) => list[Math.floor(random() * list.length)];
    const viewers = Array.from({ length: 220 }, (_, i) => `${pick(NAME_PARTS[0])}_${pick(NAME_PARTS[1])}${i % 7 === 0 ? Math.floor(random() * 99) : ""}`);

    const messages = [];
    // Background chatter that slowly grows and shrinks across the stream.
    for (let t = 0; t < STREAM_SECONDS; t += 1) {
      const progress = t / STREAM_SECONDS;
      const rate = 0.12 + 0.18 * Math.sin(Math.PI * progress) + 0.04 * Math.sin(t / 90);
      if (random() < rate) {
        messages.push({ timestamp: t + Number(random().toFixed(2)), author: pick(viewers), message: pick(IDLE_CHAT) });
      }
    }
    // Reaction bursts.
    for (const event of EVENTS) {
      for (let t = 0; t < event.seconds; t += 1) {
        const decay = Math.exp(-t / (event.seconds / 2.5));
        let n = event.rate * decay * (1 + random());
        while (n > 0) {
          if (random() < n) {
            messages.push({ timestamp: event.at + t + Number(random().toFixed(2)), author: pick(viewers), message: pick(event.lines) });
          }
          n -= 1;
        }
      }
    }
    return messages.sort((a, b) => a.timestamp - b.timestamp);
  }

  return { generateSampleChat, EVENTS, STREAM_SECONDS };
});
