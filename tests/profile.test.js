// Run with: npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const P = require("../frontend/profile.js");
const R = require("../frontend/reactions.js");
const A = require("../frontend/analysis.js");

function memoryStorage() {
  const data = new Map();
  return {
    data,
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
  };
}

test("normalize fills defaults and drops invalid values", () => {
  const p = P.normalize({
    channel: { name: "CDawg", platform: "kick", about: "x".repeat(900) },
    emotes: { kaicFireMGM: "hype", "has space": "hype", bad: "nope" },
    defaults: { sensitivity: "extreme", windowSeconds: 20, minMessages: 0, sort: "time", fps: 60 },
  });
  assert.equal(p.channel.platform, "twitch");
  assert.equal(p.channel.about.length, 600);
  assert.deepEqual(p.emotes, { kaicFireMGM: "hype" });
  assert.deepEqual(p.defaults, { sensitivity: "medium", windowSeconds: 15, minMessages: 5, sort: "time", fps: 60 });
  assert.deepEqual(P.normalize(null), P.normalize({}));
});

test("emote lines: several separators, labels or ids, and readable errors", () => {
  const labels = Object.fromEntries(R.TYPES.map((t) => [t.id, t.label]));
  const { emotes, errors } = P.parseEmoteLines("kaicFireMGM = hype\ncdawgBonk: Laughter\n# a comment\n\nkaicENAT -> Chat voting\nnoreaction\nfoo = dancing", labels);
  assert.deepEqual(emotes, { kaicFireMGM: "hype", cdawgBonk: "laughter", kaicENAT: "voting" });
  assert.deepEqual(errors, ['Line 6: use "emote = reaction"', 'Line 7: "dancing" isn\'t a reaction type']);
  assert.equal(P.formatEmoteLines(emotes), "cdawgBonk = laughter\nkaicENAT = voting\nkaicFireMGM = hype");
});

test("the API key is only stored when the person asks", () => {
  const storage = memoryStorage();
  const store = P.store(storage);
  store.save(P.normalize({ channel: { name: "Kai" } }), "AIzaSecret");
  assert.equal(storage.getItem("viewtopsy.aiKey"), null);
  assert.equal(store.load().apiKey, "");
  assert.equal(store.load().profile.channel.name, "Kai");

  store.save(P.normalize({ ai: { rememberKey: true } }), "AIzaSecret");
  assert.equal(store.load().apiKey, "AIzaSecret");

  store.save(P.normalize({ ai: { rememberKey: false } }), "AIzaSecret");
  assert.equal(storage.getItem("viewtopsy.aiKey"), null); // unticking forgets it

  store.clear();
  assert.equal(storage.data.size, 0);
});

test("storage that throws doesn't break anything", () => {
  const broken = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); }, removeItem() { throw new Error("blocked"); } };
  const store = P.store(broken);
  assert.deepEqual(store.load(), { profile: P.normalize({}), apiKey: "" });
  assert.equal(store.save(P.normalize({}), "k"), false);
  assert.doesNotThrow(() => store.clear());
  assert.equal(P.store(null).save(P.normalize({}), ""), false);
});

test("backup files never include the key and must be Viewtopsy profiles", () => {
  const file = P.toExport({ ai: { rememberKey: true, model: "auto" }, channel: { name: "Kai" } });
  assert.doesNotMatch(file, /AIza|apiKey/);
  assert.equal(P.fromImport(file).channel.name, "Kai");
  assert.throws(() => P.fromImport(JSON.stringify({ tool: "something-else" })), /isn't a Viewtopsy profile/);
});

test("custom emotes change how chat is read", () => {
  assert.deepEqual(R.classifyMessage("kaicFireMGM kaicFireMGM"), []);
  R.setCustomEmotes({ kaicFireMGM: "hype", cdawgBonk: "laughter", junk: "not-a-type" });
  assert.deepEqual(R.classifyMessage("kaicFireMGM kaicFireMGM"), ["hype"]);
  assert.deepEqual(R.classifyMessage("CDAWGBONK"), ["laughter"]);
  assert.deepEqual(R.classifyMessage("junk"), []);
  R.setCustomEmotes({});
  assert.deepEqual(R.classifyMessage("kaicFireMGM"), []);
});

test("emotes are counted from TwitchDownloader fragments", () => {
  const comment = (body, fragments) => ({ content_offset_seconds: 1, commenter: { display_name: "a" }, message: { body, fragments } });
  const raw = JSON.stringify({
    video: { id: "1" },
    comments: [
      comment("kaicFireMGM W", [{ text: "kaicFireMGM", emoticon: { emoticon_id: "1" } }, { text: " W", emoticon: null }]),
      comment("kaicFireMGM", [{ text: "kaicFireMGM", emoticon: { emoticon_id: "1" } }]),
      comment("LUL", [{ text: "LUL", emoticon: { emoticon_id: "2" } }]),
    ],
  });
  assert.deepEqual(A.readChatInfo(raw).emotes, [{ name: "kaicFireMGM", count: 2 }, { name: "LUL", count: 1 }]);
});
