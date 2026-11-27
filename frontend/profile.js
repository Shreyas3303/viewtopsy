/*
 * The person's saved profile: AI settings, channel details, custom emotes and
 * default analysis settings. Kept in this browser's local storage; the API key
 * is stored separately and only when the person asks for it to be remembered.
 * Pure functions plus a storage wrapper: browser (window.ViewtopsyProfile) and Node.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.ViewtopsyProfile = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const PROFILE_KEY = "viewtopsy.profile";
  const API_KEY_KEY = "viewtopsy.aiKey";

  const REACTION_IDS = ["laughter", "hype", "shock", "tension", "sad", "love", "disapproval", "voting", "confusion", "support", "greeting"];

  const DEFAULTS = Object.freeze({
    version: 1,
    ai: { rememberKey: false, model: "auto" },
    channel: { name: "", platform: "twitch", about: "" },
    emotes: {},
    defaults: { sensitivity: "medium", windowSeconds: 15, minMessages: 5, sort: "rank", fps: 30 },
  });

  const pick = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);
  const text = (value, max) => (typeof value === "string" ? value.slice(0, max) : "");

  /** Fills in missing fields and drops anything invalid. */
  function normalize(input) {
    const p = input && typeof input === "object" ? input : {};
    const d = p.defaults || {};
    const emotes = {};
    for (const [name, id] of Object.entries(p.emotes || {})) {
      const clean = String(name).trim();
      if (clean && clean.length <= 40 && !/\s/.test(clean) && REACTION_IDS.includes(id)) emotes[clean] = id;
    }
    const minMessages = Number(d.minMessages);
    return {
      version: 1,
      ai: {
        rememberKey: Boolean(p.ai?.rememberKey),
        model: text(p.ai?.model, 80) || "auto",
      },
      channel: {
        name: text(p.channel?.name, 60).trim(),
        platform: pick(p.channel?.platform, ["twitch", "youtube"], "twitch"),
        about: text(p.channel?.about, 600).trim(),
      },
      emotes,
      defaults: {
        sensitivity: pick(d.sensitivity, ["low", "medium", "high"], "medium"),
        windowSeconds: pick(Number(d.windowSeconds), [10, 15, 30, 60], 15),
        minMessages: Number.isInteger(minMessages) && minMessages >= 1 && minMessages <= 10000 ? minMessages : 5,
        sort: pick(d.sort, ["rank", "time"], "rank"),
        fps: pick(Number(d.fps), [24, 25, 30, 60], 30),
      },
    };
  }

  /**
   * Reads "emote = reaction" lines. Accepts "=", ":" or "->" and reaction
   * labels or ids ("Laughter", "laughter", "Chat voting", "voting").
   * @returns {{emotes: object, errors: string[]}}
   */
  function parseEmoteLines(input, labels = {}) {
    const byLabel = new Map(REACTION_IDS.map((id) => [id, id]));
    for (const [id, label] of Object.entries(labels)) byLabel.set(String(label).toLowerCase(), id);
    const emotes = {};
    const errors = [];
    String(input || "").split(/\r?\n/).forEach((line, i) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return;
      const match = trimmed.match(/^(\S+)\s*(?:=|:|->)\s*(.+)$/);
      if (!match) {
        errors.push(`Line ${i + 1}: use "emote = reaction"`);
        return;
      }
      const id = byLabel.get(match[2].trim().toLowerCase());
      if (!id) {
        errors.push(`Line ${i + 1}: "${match[2].trim()}" isn't a reaction type`);
        return;
      }
      emotes[match[1]] = id;
    });
    return { emotes, errors };
  }

  function formatEmoteLines(emotes) {
    return Object.entries(emotes || {})
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([name, id]) => `${name} = ${id}`)
      .join("\n");
  }

  /** Profile as a backup file. Never includes the API key. */
  function toExport(profile) {
    return JSON.stringify({ tool: "viewtopsy-profile", ...normalize(profile) }, null, 2);
  }

  function fromImport(raw) {
    const data = JSON.parse(raw);
    if (!data || (data.tool && data.tool !== "viewtopsy-profile")) throw new Error("That isn't a Viewtopsy profile file.");
    return normalize(data);
  }

  /** Wraps localStorage; every call survives storage being unavailable. */
  function store(storage) {
    const safe = (fn, fallback) => {
      try {
        return fn();
      } catch {
        return fallback;
      }
    };
    return {
      load() {
        const raw = safe(() => storage.getItem(PROFILE_KEY), null);
        const profile = normalize(raw ? safe(() => JSON.parse(raw), {}) : {});
        const apiKey = profile.ai.rememberKey ? safe(() => storage.getItem(API_KEY_KEY), "") || "" : "";
        return { profile, apiKey };
      },
      save(profile, apiKey) {
        const clean = normalize(profile);
        const ok = safe(() => {
          storage.setItem(PROFILE_KEY, JSON.stringify(clean));
          return true;
        }, false);
        safe(() => {
          if (clean.ai.rememberKey && apiKey) storage.setItem(API_KEY_KEY, apiKey);
          else storage.removeItem(API_KEY_KEY);
        });
        return ok;
      },
      clear() {
        safe(() => storage.removeItem(PROFILE_KEY));
        safe(() => storage.removeItem(API_KEY_KEY));
      },
    };
  }

  return { DEFAULTS, REACTION_IDS, normalize, parseEmoteLines, formatEmoteLines, toExport, fromImport, store };
});
