// modelStrip (0.5.31) — port of O‍mniRoute's providerFieldStrips.
//
// Strip fields that are known to cause 400 Bad Request errors on certain
// models or providers (e.g. Groq rejecting logprobs, or open-source models
// rejecting reasoning_budget).

const KNOWN_OFFENDING_FIELDS = [
  "reasoning_budget",
  "chat_template",
  "reasoning_content",
  "logprobs",
  "logit_bias",
  "top_logprobs",
  "presence_penalty",
  "frequency_penalty",
];

// Return the first known-offending field literally named in a 400 body, or null.
// Used for reactive self-healing (if upstream complains about 'logprobs', strip
// it and retry).
//
// Word-boundary match catches every real-world phrasing observed in upstream
// 400 bodies:
//   xAI       — `Parameter 'logprobs' not supported`            (single-quoted)
//   Groq      — `Unknown parameter: logprobs`                    (bare)
//   OpenRouter— `unrecognized field reasoning_content`           (bare)
//   Anthropic — `Field \"presence_penalty\" invalid`             (escaped double quotes)
//
// The previous quote-only matcher missed the bare and escaped-quote cases. Over-
// broad regex matches are safe here: the worst case is stripping a named field
// that wasn't the actual cause, and the retry then resends without it.
const FIELD_REGEX_CACHE = new Map();
function fieldRegex(field) {
  let re = FIELD_REGEX_CACHE.get(field);
  if (!re) {
    // \b is ASCII word boundary which works for these snake_case field names.
    re = new RegExp(`\\b${field}\\b`);
    FIELD_REGEX_CACHE.set(field, re);
  }
  return re;
}

export function findOffendingField(bodyText) {
  if (typeof bodyText !== "string" || !bodyText) return null;
  for (const field of KNOWN_OFFENDING_FIELDS) {
    if (fieldRegex(field).test(bodyText)) {
      return field;
    }
  }
  return null;
}

// Proactive strip: mutate request body to drop fields that are known to break
// specific providers (e.g., Groq, Fireworks).
export function stripUnsupportedFields(body, provider) {
  if (!body || typeof body !== "object") return body;
  const next = { ...body };

  // Groq / Fireworks / general OSS providers often reject these advanced OpenAI params
  if (provider === "groq" || provider === "fireworks" || provider === "openrouter") {
    delete next.logprobs;
    delete next.logit_bias;
    delete next.top_logprobs;
  }

  // 0.5.72 — Atomesus uses an inference backend that crashes if `tools` are present
  // (returning '"auto" tool choice requires --enable-auto-tool-choice'). Strip
  // tools completely to force plain text fallback.
  if (provider === "atomesus" || provider === "atms") {
    delete next.tools;
    delete next.tool_choice;
  }

  // If messages have an unexpected 'name' field, some strict providers reject it
  if (Array.isArray(next.messages)) {
    next.messages = next.messages.map(m => {
      if (m && typeof m === "object" && "name" in m && m.role !== "function" && m.role !== "tool") {
        const { name, ...rest } = m;
        return rest;
      }
      return m;
    });
  }

  return next;
}
