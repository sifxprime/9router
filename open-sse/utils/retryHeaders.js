// Extract precise retry-after timing from HTTP response headers.
//
// Most providers tell us *exactly* when the rate limit resets via headers, but
// kRouter previously fell back to a generic 2-8s exponential backoff for any
// 429. That wastes retries (provider says "wait 120s" — we keep retrying every
// 2s and burning 429s) and is suboptimal on the other side too (provider says
// "wait 500ms" — we wait the full 2s backoff anyway).
//
// This helper reads the standard + provider-specific headers and returns the
// earliest reset epoch (ms) we can derive. Returns `null` if nothing usable.
//
// Headers consulted (in priority order):
//
//   1. Retry-After                       — RFC 7231 (OpenAI, Anthropic, NVIDIA, Groq, etc.)
//                                          Value: seconds (integer) OR HTTP-date
//   2. anthropic-ratelimit-tokens-reset  — ISO-8601 datetime (Anthropic)
//   3. anthropic-ratelimit-requests-reset — ISO-8601 datetime (Anthropic)
//   4. x-ratelimit-reset-requests        — duration like "6m0s" / "1h2m3s" / "60s" / number-of-seconds (OpenAI)
//   5. x-ratelimit-reset-tokens          — same format as above (OpenAI)
//   6. x-ratelimit-reset                 — unix-epoch seconds OR duration string (xAI, Together, Groq, Fireworks)
//   7. x-ratelimit-reset-after           — seconds (some forks)
//
// If multiple values are present we return the **earliest reset epoch** —
// kRouter only needs to know "when CAN we try again on this account".

const HEADER_KEYS = [
  "retry-after",
  "anthropic-ratelimit-tokens-reset",
  "anthropic-ratelimit-requests-reset",
  "x-ratelimit-reset-requests",
  "x-ratelimit-reset-tokens",
  "x-ratelimit-reset",
  "x-ratelimit-reset-after",
];

// Parse OpenAI-style duration like "6m0s", "1h2m3s", "500ms".
// Returns milliseconds. Returns null on unknown shape.
function parseDuration(raw) {
  if (typeof raw !== "string") return null;
  const s = raw.trim().toLowerCase();
  if (!s) return null;

  // Plain number → seconds (legacy x-ratelimit-reset)
  if (/^\d+$/.test(s)) return Number(s) * 1000;
  if (/^\d+\.\d+$/.test(s)) return Number(s) * 1000;

  let totalMs = 0;
  const re = /(\d+(?:\.\d+)?)\s*(ms|s|m|h)/g;
  let m;
  let matched = false;
  while ((m = re.exec(s)) !== null) {
    matched = true;
    const n = parseFloat(m[1]);
    switch (m[2]) {
      case "ms": totalMs += n; break;
      case "s":  totalMs += n * 1000; break;
      case "m":  totalMs += n * 60 * 1000; break;
      case "h":  totalMs += n * 60 * 60 * 1000; break;
    }
  }
  return matched ? totalMs : null;
}

// Convert a single header value into an absolute reset epoch (ms).
function headerValueToEpochMs(key, rawValue) {
  if (rawValue == null) return null;
  const value = String(rawValue).trim();
  if (!value) return null;
  const now = Date.now();

  // Retry-After: integer seconds OR HTTP-date
  if (key === "retry-after") {
    if (/^\d+$/.test(value)) return now + Number(value) * 1000;
    const dateMs = Date.parse(value);
    return Number.isFinite(dateMs) ? dateMs : null;
  }

  // ISO-8601 datetime (Anthropic reset headers)
  if (key.startsWith("anthropic-ratelimit-")) {
    const dateMs = Date.parse(value);
    return Number.isFinite(dateMs) ? dateMs : null;
  }

  // OpenAI / xAI / Groq style — duration or unix seconds
  if (key.startsWith("x-ratelimit-reset")) {
    // Heuristic: if it's a 10-digit number, treat as unix seconds; else duration
    if (/^\d{10}(\.\d+)?$/.test(value)) {
      return Number(value) * 1000;
    }
    const dur = parseDuration(value);
    if (dur != null) return now + dur;
  }

  return null;
}

/**
 * Parse all known retry-related headers from a Response (or HeadersLike).
 * Returns { resetsAtMs, source } — the earliest reset epoch + which header it came from.
 * Returns { resetsAtMs: null } if no usable header found.
 *
 * @param {Response|Headers|object} responseOrHeaders
 * @returns {{ resetsAtMs: number|null, source?: string }}
 */
export function parseRetryAfterHeaders(responseOrHeaders) {
  if (!responseOrHeaders) return { resetsAtMs: null };

  // Normalize: support fetch Response, Headers object, or plain object.
  const get = (k) => {
    if (typeof responseOrHeaders.headers?.get === "function") {
      return responseOrHeaders.headers.get(k);
    }
    if (typeof responseOrHeaders.get === "function") {
      return responseOrHeaders.get(k);
    }
    // Plain object — case-insensitive lookup
    const lower = k.toLowerCase();
    for (const [hk, hv] of Object.entries(responseOrHeaders)) {
      if (hk.toLowerCase() === lower) return hv;
    }
    return null;
  };

  let earliest = null;
  let source = null;
  for (const key of HEADER_KEYS) {
    const raw = get(key);
    if (raw == null) continue;
    const epoch = headerValueToEpochMs(key, raw);
    if (epoch != null && epoch > Date.now()) {
      if (earliest == null || epoch < earliest) {
        earliest = epoch;
        source = key;
      }
    }
  }

  return earliest ? { resetsAtMs: earliest, source } : { resetsAtMs: null };
}
