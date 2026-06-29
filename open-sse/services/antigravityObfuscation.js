// antigravityObfuscation (0.5.29) — port of OmniRoute's antigravityObfuscation.
//
// Obfuscates client tool names (OpenCode, Cursor, Claude Code, etc.) in
// the request body using zero-width joiners so Google's backend can't
// grep for them in request logs to flag third-party clients.
//
// Pure function — accepts a string body, returns string with sensitive
// words split by a U+200D ZWJ. Visually identical, byte-different.

const ZWJ = "‍";

const DEFAULT_SENSITIVE_WORDS = [
  "opencode",
  "open-code",
  "cline",
  "roo-cline",
  "roo_cline",
  "cursor",
  "windsurf",
  "aider",
  "continue.dev",
  "copilot",
  "avante",
  "codecompanion",
  "claude code",
  "claude-code",
  "kilo code",
  "kilocode",
  "kodelyth",
  "krouter",
  "omniroute",
];

let configuredWords = [...DEFAULT_SENSITIVE_WORDS];

export function setAntigravitySensitiveWords(words) {
  configuredWords = Array.isArray(words) && words.length > 0
    ? words.filter(w => typeof w === "string" && w.length > 0)
    : [...DEFAULT_SENSITIVE_WORDS];
}

export function getAntigravitySensitiveWords() {
  return [...configuredWords];
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const _regexCache = new Map();
function getObfuscationRegex(word) {
  let regex = _regexCache.get(word);
  if (!regex) {
    if (_regexCache.size > 2000) _regexCache.clear();
    regex = new RegExp(escapeRegex(word), "gi");
    _regexCache.set(word, regex);
  }
  return regex;
}

// Inject a ZWJ after the first character of every sensitive word in `text`.
// "opencode" → "o<ZWJ>pencode". Visually identical, breaks grep / regex
// fingerprinting on Google's side.
export function obfuscateSensitiveWords(text) {
  if (typeof text !== "string" || !text || configuredWords.length === 0) return text;
  let result = text;
  for (const word of configuredWords) {
    if (!word) continue;
    const regex = getObfuscationRegex(word);
    result = result.replace(regex, (m) => (m.length <= 1 ? m : m[0] + ZWJ + m.slice(1)));
  }
  return result;
}

// 0.5.43 — Field names whose VALUES are raw binary data (base64-encoded
// images, audio, PDFs, etc.) and MUST NEVER be touched by string-level
// obfuscation. Injecting a ZWJ into a base64 blob shifts every subsequent
// byte → Google rejects the upload with a 400 "base64 decoding failed".
//
// Real-world failure that motivated this: a user sent a JPEG inline with
// Kiro IDE. The JPEG's base64 happened to contain the sub-string "cursor"
// somewhere in its random byte payload. The regex injected a ZWJ. Google
// 400'd. Took 6 versions to track down because the corruption is invisible
// in any text dump (ZWJ is zero-width).
const BINARY_DATA_FIELDS = new Set([
  "data",          // Gemini parts[].inlineData.data — raw base64 image/audio
  "inline_data",   // OpenAI compatibility alias
  "inlineData",    // some clients send the camelCase wrapper as a string
  "bytes",         // Anthropic image content blocks
  "base64",        // generic
  "b64_json",      // OpenAI image gen response shape (echoed back in history)
  "image",         // raw base64 image
  "url",           // OpenAI / Claude image_url.url fields. Do not inject ZWJ into URLs or they 404
]);

function isLikelyDataUrl(s) {
  return typeof s === "string" && s.length > 32 && s.startsWith("data:") && s.includes(";base64,");
}

// Convenience: walk an arbitrary body shape and obfuscate every string
// field (depth-limited so we don't blow the stack on circular bodies).
// Returns a new object — never mutates input.
//
// Keys listed in BINARY_DATA_FIELDS are passed through unchanged. Strings
// that look like a data: URL (`data:image/jpeg;base64,...`) are also
// passed through unchanged regardless of their key name, because some
// clients embed the whole data URL inside `image_url.url` or `content.text`.
export function obfuscateBodyStrings(body, maxDepth = 8, parentKey = null) {
  if (maxDepth <= 0) return body;
  if (typeof body === "string") {
    if (parentKey && BINARY_DATA_FIELDS.has(parentKey)) return body;
    if (isLikelyDataUrl(body)) return body;
    return obfuscateSensitiveWords(body);
  }
  if (Array.isArray(body)) {
    return body.map(v => obfuscateBodyStrings(v, maxDepth - 1, parentKey));
  }
  if (body && typeof body === "object") {
    const out = {};
    for (const [k, v] of Object.entries(body)) {
      out[k] = obfuscateBodyStrings(v, maxDepth - 1, k);
    }
    return out;
  }
  return body;
}
