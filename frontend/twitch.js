/*
 * BETA: "Connect with Twitch" and fetching a VOD's clips from the browser.
 *
 * Uses Twitch's implicit grant flow, which is meant for browser apps: the page
 * sends you to Twitch to log in, Twitch sends you back with a user access token
 * in the URL, and no client secret is ever needed. Twitch only sends people
 * back to a registered http(s) address, so this needs Viewtopsy to be opened
 * from a local server (npm run serve), not as a file.
 *
 * Nothing else in Viewtopsy depends on this module.
 * Browser (window.ViewtopsyTwitch) and Node (tests).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.ViewtopsyTwitch = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const AUTHORIZE_URL = "https://id.twitch.tv/oauth2/authorize";
  const VALIDATE_URL = "https://id.twitch.tv/oauth2/validate";
  const HELIX = "https://api.twitch.tv/helix";

  /**
   * The address Twitch should send people back to: this page, without
   * "index.html" or any query or hash. It must match the app's registered
   * OAuth Redirect URL exactly.
   */
  function redirectUri(location) {
    return `${location.origin}${location.pathname.replace(/index\.html$/, "")}`;
  }

  /** Why Connect can't work from this page, or "" if it can. */
  function unsupportedReason(location) {
    if (location.protocol === "file:") {
      return "Twitch can't send you back to a page opened as a file. Start Viewtopsy with “npm run serve” and open http://localhost:8000 instead.";
    }
    if (!/^https?:$/.test(location.protocol)) return "This page's address can't be used as a Twitch redirect.";
    return "";
  }

  function authorizeUrl({ clientId, redirect, state }) {
    const params = new URLSearchParams({
      response_type: "token",
      client_id: clientId,
      redirect_uri: redirect,
      scope: "", // reading public VODs and clips needs no extra permissions
      state,
    });
    return `${AUTHORIZE_URL}?${params}`;
  }

  /**
   * Reads what Twitch put in the URL fragment on the way back.
   * @returns {null | {token, state} | {error, description, state}}
   */
  function parseRedirect(hash, search = "") {
    const fragment = new URLSearchParams(String(hash || "").replace(/^#/, ""));
    const query = new URLSearchParams(String(search || "").replace(/^\?/, ""));
    if (fragment.get("access_token")) {
      return { token: fragment.get("access_token"), state: fragment.get("state") || "" };
    }
    // Twitch reports errors (e.g. the person clicked Cancel) in the query string.
    const error = query.get("error") || fragment.get("error");
    if (error) {
      return { error, description: (query.get("error_description") || fragment.get("error_description") || "").replace(/\+/g, " "), state: query.get("state") || fragment.get("state") || "" };
    }
    return null;
  }

  function randomState() {
    const bytes = new Uint8Array(16);
    (globalThis.crypto || require("crypto").webcrypto).getRandomValues(bytes);
    return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  class TwitchError extends Error {
    constructor(message, { status, reconnect = false } = {}) {
      super(message);
      this.status = status;
      this.reconnect = reconnect;
    }
  }

  async function request(url, { headers, fetchImpl }) {
    let response;
    try {
      response = await fetchImpl(url, { headers });
    } catch {
      throw new TwitchError("Couldn't reach Twitch. An ad blocker or Brave Shields may be blocking twitch.tv; try turning it off for this page.");
    }
    const body = await response.json().catch(() => null);
    if (response.status === 401) {
      throw new TwitchError("Your Twitch connection has expired or was revoked. Reconnect in Profile.", { status: 401, reconnect: true });
    }
    if (!response.ok) {
      throw new TwitchError(`Twitch returned an error: ${body?.message || `HTTP ${response.status}`}`, { status: response.status });
    }
    return body;
  }

  /**
   * Checks a token and returns who it belongs to and when it expires.
   * @returns {{login: string, clientId: string, expiresAt: number|null}}
   */
  async function validateToken(token, { fetchImpl = fetch, now = Date.now() } = {}) {
    const body = await request(VALIDATE_URL, { headers: { Authorization: `OAuth ${token}` }, fetchImpl });
    return {
      login: body?.login || "",
      clientId: body?.client_id || "",
      expiresAt: Number.isFinite(body?.expires_in) && body.expires_in > 0 ? now + body.expires_in * 1000 : null,
    };
  }

  /**
   * Clips cut from one VOD, with where each starts in the VOD.
   * Same result shape as `stream-moments fetch-clips`, so the app treats both alike.
   */
  async function fetchVodClips(videoId, { clientId, token, fetchImpl = fetch, maxPages = 20, onProgress = () => {} } = {}) {
    if (!clientId || !token) throw new TwitchError("Connect Twitch in Profile first.", { reconnect: true });
    const id = String(videoId || "").trim();
    if (!/^\d+$/.test(id)) throw new TwitchError("Clips can only be fetched for a Twitch VOD. Add the VOD link on the Analyze page.");
    const headers = { "Client-Id": clientId, Authorization: `Bearer ${token}` };

    const videos = await request(`${HELIX}/videos?id=${encodeURIComponent(id)}`, { headers, fetchImpl });
    const video = videos?.data?.[0];
    if (!video) throw new TwitchError(`Twitch has no VOD ${id}. It may have been deleted.`);

    const clips = [];
    let cursor = "";
    let pages = 0;
    for (; pages < maxPages; pages += 1) {
      const params = new URLSearchParams({ broadcaster_id: video.user_id, started_at: video.created_at, first: "100" });
      if (cursor) params.set("after", cursor);
      const page = await request(`${HELIX}/clips?${params}`, { headers, fetchImpl });
      for (const clip of page?.data || []) {
        if (String(clip.video_id) === id) {
          clips.push({
            id: clip.id, url: clip.url, title: clip.title, view_count: clip.view_count, vod_offset: clip.vod_offset,
            duration: clip.duration, creator_name: clip.creator_name, created_at: clip.created_at, video_id: clip.video_id,
          });
        }
      }
      onProgress({ pages: pages + 1, clips: clips.length });
      cursor = page?.pagination?.cursor || "";
      if (!cursor) break;
    }
    clips.sort((a, b) => (a.vod_offset == null) - (b.vod_offset == null) || (a.vod_offset || 0) - (b.vod_offset || 0));
    return { video_id: id, title: video.title || "", channel: video.user_name || "", clips, truncated: Boolean(cursor) && pages >= maxPages };
  }

  return { redirectUri, unsupportedReason, authorizeUrl, parseRedirect, randomState, validateToken, fetchVodClips, TwitchError };
});
