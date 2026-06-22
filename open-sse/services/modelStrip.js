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
export function findOffendingField(bodyText) {
  if (typeof bodyText !== "string" || !bodyText) return null;
  for (const field of KNOWN_OFFENDING_FIELDS) {
    if (bodyText.includes(`'${field}'`) || bodyText.includes(`"${field}"`) || bodyText.includes(`\`${field}\``)) {
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
