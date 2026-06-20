// Strip request params a given provider/model rejects upstream (e.g. HTTP 400).
//
// Config-driven so a single rule table is the source of truth instead of
// `delete body.x` lines scattered across executors. Add a new entry to
// STRIP_RULES whenever a provider rejects a param for some model.
//
// Ported from upstream commit 7ae9fff (fix #1748). Kept in
// translator/helpers/ to match our existing file layout (upstream places it
// under translator/concerns/ post-refactor — same shape, different path).

// Each rule:
//   provider?  string  — restrict to this provider id; omit to apply globally
//   match      RegExp | (model) => boolean  — predicate on the model id
//   drop       string[]  — request-body keys to remove when both checks pass
const STRIP_RULES = [
  // Anthropic claude-opus-4 series: `temperature` is rejected by the upstream
  // API (400 "deprecated for this model"). Hits any path that routes to a
  // claude-opus-4 model regardless of provider (direct Anthropic, Copilot, Kiro
  // pass-through, etc.). Ref: upstream #1748.
  { match: /claude-opus-4/i, drop: ["temperature"] },

  // GitHub Copilot's gpt-5.4 family rejects `temperature`.
  { provider: "github", match: /gpt-5\.4/i, drop: ["temperature"] },

  // GitHub Copilot Claude models — Copilot's /chat/completions doesn't
  // understand Claude-style `thinking` payloads, and only Claude opus 4.6 /
  // sonnet 4.6 honour `reasoning_effort` on Copilot; everything else (Claude
  // Haiku 4.5, Claude Opus 4.7, etc.) rejects it. Strip both keys for Claude
  // models that aren't the two opus/sonnet 4.6 exceptions. Ref: upstream #713.
  //
  // Note: kRouter's model registry uses BOTH dot ("claude-opus-4.6") and
  // hyphen ("claude-opus-4-6", "claude-opus-4-6-thinking") forms — upstream's
  // literal-dot regex only matched the first, so on our codebase the 4.6
  // exception failed to fire and stripped thinking from valid 4.6 requests.
  // Allow [.\-] between the version digits to cover both.
  {
    provider: "github",
    match: (m) => /claude/i.test(m) && !/claude.*(opus|sonnet).*4[.\-]6/i.test(m),
    drop: ["thinking", "reasoning_effort"],
  },
];

function matches(rule, model) {
  return typeof rule.match === "function" ? rule.match(model) : rule.match.test(model);
}

/**
 * Mutate `body` to remove any param a provider/model is known to reject.
 * Returns the same body for chainability.
 *
 * @param {string} provider  provider id (e.g. "claude", "github")
 * @param {string} model     upstream model id (e.g. "claude-opus-4-6")
 * @param {object} body      request body (will be mutated in place)
 * @returns {object} body
 */
export function stripUnsupportedParams(provider, model, body) {
  if (!model || !body || typeof body !== "object") return body;
  for (const rule of STRIP_RULES) {
    if (rule.provider && rule.provider !== provider) continue;
    if (!matches(rule, model)) continue;
    for (const key of rule.drop) {
      if (body[key] !== undefined) delete body[key];
    }
  }
  return body;
}

// Test hook so unit tests can exercise rules without spinning up an executor.
export const __test__ = { STRIP_RULES, matches };
