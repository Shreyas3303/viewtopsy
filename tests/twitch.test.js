// Run with: npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const T = require("../frontend/twitch.js");
const P = require("../frontend/profile.js");

const loc = (href) => new URL(href);

test("redirect URL is this page without index.html, query or hash", () => {
  assert.equal(T.redirectUri(loc("http://localhost:8000/")), "http://localhost:8000/");
  assert.equal(T.redirectUri(loc("http://localhost:8000/index.html?x=1#y")), "http://localhost:8000/");
  assert.equal(T.redirectUri(loc("http://localhost:8000/frontend/index.html")), "http://localhost:8000/frontend/");
});

test("Connect isn't offered for pages opened as files", () => {
  assert.match(T.unsupportedReason(loc("file:///C:/viewtopsy/frontend/index.html")), /npm run serve/);
  assert.equal(T.unsupportedReason(loc("http://localhost:8000/")), "");
});

test("authorize URL asks for a token with no extra permissions", () => {
  const url = new URL(T.authorizeUrl({ clientId: "abc123", redirect: "http://localhost:8000/", state: "s1" }));
  assert.equal(url.origin + url.pathname, "https://id.twitch.tv/oauth2/authorize");
  assert.equal(url.searchParams.get("response_type"), "token");
  assert.equal(url.searchParams.get("client_id"), "abc123");
  assert.equal(url.searchParams.get("redirect_uri"), "http://localhost:8000/");
  assert.equal(url.searchParams.get("scope"), "");
  assert.equal(url.searchParams.get("state"), "s1");
});

test("reads Twitch's reply from the address bar", () => {
  assert.deepEqual(T.parseRedirect("#access_token=tok123&scope=&state=s1&token_type=bearer"), { token: "tok123", state: "s1" });
  assert.deepEqual(
    T.parseRedirect("", "?error=access_denied&error_description=The+user+denied+you+access&state=s1"),
    { error: "access_denied", description: "The user denied you access", state: "s1" },
  );
  assert.equal(T.parseRedirect("#section", ""), null);
  assert.equal(T.parseRedirect("", ""), null);
});

test("state values are random and long enough", () => {
  const a = T.randomState();
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.notEqual(a, T.randomState());
});

/** A fake Twitch: one VOD, two pages of clips, some from other VODs. */
function fakeTwitch({ expired = false } = {}) {
  const calls = [];
  const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
  const fetchImpl = async (url, init) => {
    calls.push({ url, headers: init.headers });
    if (expired) return json(401, { message: "Invalid OAuth token" });
    if (url.startsWith("https://id.twitch.tv/oauth2/validate")) return json(200, { client_id: "abc123", login: "shreyas", expires_in: 3600 * 24 * 50 });
    if (url.includes("/helix/videos")) return json(200, { data: [{ id: "2939504732", user_id: "641972806", user_name: "KaiCenat", title: "KAI VS SPEED", created_at: "2026-11-24T17:36:25Z" }] });
    const params = new URL(url).searchParams;
    if (!params.get("after")) {
      return json(200, { data: [
        { id: "Late", url: "u", title: "late", view_count: 5, vod_offset: 5000, duration: 30, creator_name: "x", created_at: "c", video_id: "2939504732" },
        { id: "Elsewhere", title: "other vod", vod_offset: 1, video_id: "111" },
      ], pagination: { cursor: "page2" } });
    }
    return json(200, { data: [
      { id: "Early", url: "u", title: "early", view_count: 50, vod_offset: 3700, duration: 20, creator_name: "y", created_at: "c", video_id: "2939504732" },
      { id: "NoOffset", title: "no offset", vod_offset: null, video_id: "2939504732" },
    ], pagination: {} });
  };
  return { fetchImpl, calls };
}

test("validates a token and works out when it expires", async () => {
  const { fetchImpl, calls } = fakeTwitch();
  const info = await T.validateToken("tok", { fetchImpl, now: 1000 });
  assert.equal(info.login, "shreyas");
  assert.equal(info.clientId, "abc123");
  assert.equal(info.expiresAt, 1000 + 3600 * 24 * 50 * 1000);
  assert.equal(calls[0].headers.Authorization, "OAuth tok");
});

test("fetches this VOD's clips across pages, in VOD order", async () => {
  const { fetchImpl, calls } = fakeTwitch();
  const pages = [];
  const result = await T.fetchVodClips("2939504732", { clientId: "abc123", token: "tok", fetchImpl, onProgress: (p) => pages.push(p.pages) });
  assert.deepEqual(result.clips.map((c) => c.id), ["Early", "Late", "NoOffset"]);
  assert.equal(result.channel, "KaiCenat");
  assert.equal(result.truncated, false);
  assert.deepEqual(pages, [1, 2]);
  const clipCall = new URL(calls[1].url);
  assert.equal(clipCall.searchParams.get("broadcaster_id"), "641972806");
  assert.equal(clipCall.searchParams.get("started_at"), "2026-11-24T17:36:25Z");
  assert.equal(calls[1].headers["Client-Id"], "abc123");
  assert.equal(calls[1].headers.Authorization, "Bearer tok");
  assert.equal(new URL(calls[2].url).searchParams.get("after"), "page2");
});

test("expired tokens ask to reconnect; bad input gives a clear error", async () => {
  await assert.rejects(
    T.fetchVodClips("2939504732", { clientId: "a", token: "old", fetchImpl: fakeTwitch({ expired: true }).fetchImpl }),
    (error) => error.reconnect === true && /expired/.test(error.message),
  );
  await assert.rejects(T.fetchVodClips("dQw4w9WgXcQ", { clientId: "a", token: "t", fetchImpl: fakeTwitch().fetchImpl }), /Twitch VOD/);
  await assert.rejects(T.fetchVodClips("123", { clientId: "", token: "t" }), /Connect Twitch/);
  const offline = async () => { throw new TypeError("Failed to fetch"); };
  await assert.rejects(T.fetchVodClips("123", { clientId: "a", token: "t", fetchImpl: offline }), /Couldn't reach Twitch/);
});

test("the Twitch connection is stored apart from the profile and drops when expired", () => {
  const data = new Map();
  const storage = { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, String(v)), removeItem: (k) => data.delete(k) };
  const store = P.store(storage);
  store.save(P.normalize({ twitch: { clientId: "abc123" } }), "");
  store.saveTwitch({ token: "tok", login: "shreyas", expiresAt: 5000, clientId: "abc123" });
  assert.equal(store.loadTwitch(1000).login, "shreyas");
  assert.equal(store.loadTwitch(6000), null); // expired
  assert.equal(store.load().profile.twitch.clientId, "abc123");
  assert.doesNotMatch(P.toExport(store.load().profile), /tok/);
  store.clearTwitch();
  assert.equal(store.loadTwitch(1000), null);
  assert.equal(P.normalize({ twitch: { clientId: "bad id!" } }).twitch.clientId, "");
});
