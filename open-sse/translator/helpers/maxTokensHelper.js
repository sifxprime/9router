import { DEFAULT_MAX_TOKENS, DEFAULT_MIN_TOKENS } from "../../config/runtimeConfig.js";

/**
 * Adjust max_tokens based on request context
 * @param {object} body - Request body
 * @returns {number} Adjusted max_tokens
 */
export function adjustMaxTokens(body) {
  let maxTokens = body.max_tokens || DEFAULT_MAX_TOKENS;

  // Auto-increase for tool calling to prevent truncated arguments
  if (body.tools && Array.isArray(body.tools) && body.tools.length > 0) {
    if (maxTokens < DEFAULT_MIN_TOKENS) {
      maxTokens = DEFAULT_MIN_TOKENS;
    }
  }

  // 0.5.66 — OpenAI / Codex backend minimum constraint.
  // Recent OpenAI model classes (gpt-4.5, gpt-5.5, o1, o3) strictly reject
  // max_tokens < 16. Claude CLI's Bash safety classifier explicitly requests
  // max_tokens=1 because it expects a single JSON structure or YES/NO token.
  // This causes OpenAI to 400, which Claude CLI surfaces to the user as
  // "model is temporarily unavailable, so auto mode cannot determine safety".
  // Enforce a hard floor of 16 to pass validation. (LLMs usually naturally
  // halt after emitting the token anyway).
  if (maxTokens < 16) {
    maxTokens = 16;
  }

  // Ensure max_tokens > thinking.budget_tokens (Claude API requirement)
  // Claude API requires strictly greater, so add buffer instead of using DEFAULT_MAX_TOKENS
  // which could equal budget_tokens when budget_tokens >= 64000
  if (body.thinking?.budget_tokens && maxTokens <= body.thinking.budget_tokens) {
    maxTokens = body.thinking.budget_tokens + 1024;
  }

  return maxTokens;
}

