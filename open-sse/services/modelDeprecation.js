// modelDeprecation (0.5.31) — port of O‍mniRoute's modelDeprecation.
//
// Maps deprecated model IDs to their active replacements. When a provider
// (like Google or Anthropic) retires a model, users with that model hardcoded
// in their combos or IDEs would normally get 404s. This automatically remaps
// the request to the official successor model.

const BUILT_IN_ALIASES = {
  // Gemini legacy → current
  "gemini-pro": "gemini-2.5-pro",
  "gemini-pro-vision": "gemini-2.5-pro",
  "gemini-1.5-pro": "gemini-2.5-pro",
  "gemini-1.5-flash": "gemini-2.5-flash",
  "gemini-1.0-pro": "gemini-2.5-pro",
  "gemini-2.0-flash": "gemini-2.5-flash",
  "gemini-3-pro-high": "gemini-3.1-pro-high",
  "gemini-3-pro-low": "gemini-3.1-pro-low",

  // Claude legacy → current
  "claude-3-opus-20240229": "claude-opus-4-20250514",
  "claude-3-sonnet-20240229": "claude-sonnet-4-20250514",
  "claude-3-haiku-20240307": "claude-3-5-sonnet-20241022",
  "claude-3-5-sonnet-latest": "claude-sonnet-4-20250514",
  "claude-3-5-haiku-latest": "claude-3-5-sonnet-20241022",

  // OpenAI legacy → current
  "gpt-4-turbo-preview": "gpt-4-turbo",
  "gpt-4-0125-preview": "gpt-4-turbo",
  "gpt-4-1106-preview": "gpt-4-turbo",
  "gpt-3.5-turbo-0125": "gpt-3.5-turbo",

  // Kimi / Fireworks
  "kimi-k2p5": "moonshotai/Kimi-K2.5",
  "kimi-k2": "moonshotai/Kimi-K2",

  // Mistral / Codestral
  "mistral-large": "mistral-large-latest",
  "mistral-small": "mistral-small-latest",
  "codestral": "codestral-latest",
  "codestral-2405": "codestral-2508", // retired 2025-06-16

  // Llama
  "llama-3.3": "llama-3.3-70b-versatile",
  "llama-3-70b": "llama-3.3-70b-versatile",
  "llama-3-8b": "llama3-8b-8192",
};

// Check if a model is deprecated and return its successor.
// Also handles "provider/model" prefixes by extracting the bare model,
// remapping it, and re-attaching the prefix.
export function resolveDeprecatedModel(modelStr) {
  if (!modelStr || typeof modelStr !== "string") return modelStr;

  let prefix = "";
  let bareModel = modelStr;

  const slashIdx = modelStr.indexOf("/");
  if (slashIdx !== -1) {
    prefix = modelStr.slice(0, slashIdx + 1);
    bareModel = modelStr.slice(slashIdx + 1);
  }

  const replacement = BUILT_IN_ALIASES[bareModel];
  if (replacement) {
    // If the replacement string already has a provider slash (e.g. moonshotai/Kimi-K2.5),
    // use it as-is. Otherwise, re-attach the original provider prefix.
    if (replacement.includes("/")) return replacement;
    return `${prefix}${replacement}`;
  }

  return modelStr;
}
