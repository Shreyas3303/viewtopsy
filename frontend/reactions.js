/*
 * Reads what kind of reaction chat is having: laughter, hype, shock and so on.
 *
 * Twitch and YouTube chat speaks in emotes and short phrases ("KEKW", "NO WAY",
 * "monkaS", "W"), so each message is matched against emote names, phrases and
 * emoji. Channel emotes ("kaicenatLUL", "cohhPog") are handled by their suffix.
 * Pure functions: runs in the browser (window.ViewtopsyReactions) and Node.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.ViewtopsyReactions = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /**
   * tokens: whole words or emote names, compared case-insensitively.
   * caseTokens: compared exactly (short ones that are normal words in lowercase).
   * phrases: lowercase text that must appear in the message.
   * patterns: regular expressions run on the original text.
   * suffixes: channel-emote endings, e.g. "LUL" matches "cohhLUL".
   */
  const TYPES = [
    {
      id: "laughter",
      label: "Laughter",
      tokens: ["kekw", "kek", "kekl", "lul", "lulw", "omegalul", "lmao", "lmfao", "lol", "lolol", "icant", "pepelaugh", "xdd", "xd", "lulx", "kekwait", "dead", "💀", "😂", "🤣"],
      patterns: [/\b(?:ha){2,}h?\b/i, /\bi can'?t\b/i, /\bim dead\b/i],
      suffixes: ["LUL", "KEKW", "LOL", "Laugh", "LAUGH", "Lmao", "LMAO", "Kek", "KEK", "Dead"],
    },
    {
      id: "hype",
      label: "Hype",
      tokens: ["pog", "pogchamp", "poggers", "pogu", "poggies", "letsgo", "letsgoo", "ez", "gigachad", "goated", "hype", "insane", "clutch", "🔥", "🐐", "peak", "cinema", "goat"],
      caseTokens: ["W", "WW", "WWW", "LETS", "GOAT"],
      phrases: ["lets go", "let's go", "clip it", "clip that", "clip this", "so good", "what a play"],
      patterns: [/^w{2,}[!\s]*$/i],
      suffixes: ["Pog", "POG", "Hype", "HYPE", "W", "Goat", "GOAT", "Fire", "Chad"],
    },
    {
      id: "shock",
      label: "Shock",
      tokens: ["wtf", "omg", "holy", "yooo", "bruh", "d:", "😱", "😳", "🤯", "😮", "wth", "nah"],
      caseTokens: ["WHAT", "WAIT", "BRO", "NO", "NOO"],
      phrases: ["no way", "no shot", "what the", "oh my god", "holy shit", "did that just", "nah bro"],
      suffixes: ["Shock", "SHOCK", "Wut", "WUT", "Omg", "OMG"],
    },
    {
      id: "tension",
      label: "Tension",
      tokens: ["monkas", "monkaw", "monkagiga", "monkah", "monkaomega", "scared", "😬", "careful", "run", "nervous", "sweating"],
      phrases: ["oh no", "don't do it", "dont do it", "behind you", "watch out", "he's gonna", "hes gonna"],
      suffixes: ["Scared", "SCARED", "Sweat", "monka"],
    },
    {
      id: "sad",
      label: "Sad",
      tokens: ["sadge", "biblethump", "pepehands", "feelsbadman", "rip", "unlucky", "unlucko", "😭", "😢", "💔", "despair", "sadkek"],
      caseTokens: ["F"],
      phrases: ["so sad", "not like this"],
      suffixes: ["Sad", "SAD", "Cry", "CRY", "Sadge"],
    },
    {
      id: "love",
      label: "Wholesome",
      tokens: ["<3", "❤", "❤️", "🥰", "😍", "🥺", "aww", "awww", "cute", "wholesome", "peepohappy", "feelsgoodman", "love", "adorable", "peepohug"],
      suffixes: ["Love", "LOVE", "Heart", "HEART", "Hug", "HUG", "L", "Cute", "Happy"],
    },
    {
      id: "disapproval",
      label: "Disapproval",
      tokens: ["cringe", "ratio", "🤡", "boo", "booo", "mid", "yikes", "residentsleeper", "notlikethis", "fraud", "washed", "trash"],
      caseTokens: ["L", "LL", "LLL"],
      phrases: ["so bad", "take the l"],
      patterns: [/^l{2,}[!\s]*$/i],
      suffixes: ["Cringe", "CRINGE", "Sleeper", "Mad", "MAD", "Rage", "RAGE"],
    },
    {
      id: "voting",
      label: "Chat voting",
      // Short answers to something the streamer asked: "YES", "no", "1", "its good", "ITS ASS".
      patterns: [
        /^(?:yes+|ye+a+h*|yep|yup|no+|nah+|nope|1|2|3|a|b|good|bad|real|fake|true|false|left|right|do it|dont|don't)[!.?\s]*$/i,
        /^(?:it'?s|it’s|its) (?:good|bad|ass|mid|fire|trash|real|fake|over)[!.\s]*$/i,
        /^(?:total|option|vote)\b/i,
      ],
    },
    {
      id: "confusion",
      label: "Confusion",
      tokens: ["huh", "??", "???", "????", "context", "confused", "🤨", "🤔"],
      phrases: ["what happened", "what did i miss", "what did he say", "what did she say", "i'm lost", "im lost"],
      patterns: [/^\?+$/],
    },
    {
      id: "support",
      label: "Support / alerts",
      tokens: ["gifted", "gifting", "subs", "bits", "donation", "donated", "raid", "raiders", "resub", "prime"],
      phrases: ["hype train", "thank you for", "thanks for the", "welcome raiders", "gift sub", "gifted sub"],
    },
    {
      id: "greeting",
      label: "Hellos / goodbyes",
      tokens: ["hi", "hello", "hey", "gn", "bye", "goodnight", "o7", "hii", "heyy", "cya", "wave"],
      phrases: ["good night", "see you", "great stream", "good stream", "thanks for streaming"],
    },
  ];

  const BY_ID = Object.fromEntries(TYPES.map((t) => [t.id, t]));

  // Precompute lookups.
  for (const type of TYPES) {
    type.tokenSet = new Set((type.tokens || []).map((t) => t.toLowerCase()));
    type.caseSet = new Set(type.caseTokens || []);
    type.suffixRe = type.suffixes
      ? new RegExp(`^[a-z][a-z0-9]{1,15}(?:${type.suffixes.join("|")})$`)
      : null;
  }

  function tokenize(text) {
    return String(text).split(/\s+/).map((t) => t.replace(/^[.,!:;"'()]+|[.,!:;"'()]+$/g, "")).filter(Boolean);
  }

  /** "LMAOOOO" -> ["LMAOOOO", "LMAO", "LMAOO"]: chat stretches words for emphasis. */
  function variants(token) {
    if (!/(.)\1\1/i.test(token)) return [token];
    return [token, token.replace(/(.)\1{2,}/gi, "$1"), token.replace(/(.)\1{2,}/gi, "$1$1")];
  }

  /** Returns the reaction type ids a single message shows. */
  function classifyMessage(text) {
    const raw = String(text || "");
    const lower = raw.toLowerCase().replace(/(.)\1{2,}/g, "$1$1");
    const tokens = tokenize(raw).flatMap(variants);
    const found = [];
    for (const type of TYPES) {
      let hit = false;
      for (const token of tokens) {
        if (type.tokenSet.has(token.toLowerCase()) || type.caseSet.has(token) || (type.suffixRe && type.suffixRe.test(token))) {
          hit = true;
          break;
        }
      }
      if (!hit && type.phrases) hit = type.phrases.some((p) => lower.includes(p));
      if (!hit && type.patterns) hit = type.patterns.some((p) => p.test(raw.trim()));
      if (hit) found.push(type.id);
    }
    return found;
  }

  /**
   * Summarises a set of messages.
   * @returns {{types: {id,label,count,share}[], dominant: string|null, readShare: number}}
   *   share is out of messages that showed any reaction; readShare is how many
   *   messages showed one at all (low means chat is mostly talking normally).
   */
  function profile(messages) {
    const counts = new Map();
    let read = 0;
    for (const message of messages) {
      const ids = classifyMessage(message.text);
      if (ids.length) read += 1;
      for (const id of ids) counts.set(id, (counts.get(id) || 0) + 1);
    }
    const types = [...counts]
      .map(([id, count]) => ({ id, label: BY_ID[id].label, count, share: read ? count / read : 0 }))
      .sort((a, b) => b.count - a.count);
    const top = types[0];
    const dominant = top && top.share >= 0.35 && read >= 3 ? top.id : null;
    return { types, dominant, readShare: messages.length ? read / messages.length : 0 };
  }

  /** Short human description, e.g. "Mostly laughter, some shock". */
  function describe(result) {
    const { types } = result;
    if (!types.length) return "No clear reaction in chat";
    const [first, second] = types;
    const main = first.share >= 0.6 ? `Mostly ${first.label.toLowerCase()}` : `${first.label}`;
    if (second && second.share >= 0.2) return `${main}, some ${second.label.toLowerCase()}`;
    return main;
  }

  return { TYPES, classifyMessage, profile, describe };
});
