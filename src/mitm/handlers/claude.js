const { err } = require("../logger");
const { fetchRouter, pipeSSE } = require("./base");

/**
 * Intercept Anthropic API request from the Claude Desktop app (Electron) or
 * any third-party app that hardcodes `https://api.anthropic.com`.
 *
 * Forwards the body unchanged (only the model field is rewritten via the
 * MITM alias table) to kRouter's own `/v1/messages` endpoint — same
 * Anthropic format, kRouter then resolves the provider + routes to whichever
 * upstream the user picked (their Claude OAuth, Antigravity, Kiro, etc.).
 *
 * Anti-loop: kRouter's outbound calls back to `api.anthropic.com` (executor
 * for claude/anthropic-compatible providers, getClaudeUsage, claudeAutoPing)
 * include the `x-request-source: local` header. The MITM server checks for
 * this BEFORE dispatching to a handler — if present, it passes through to
 * the real upstream and our intercept code is never entered.
 *
 * Endpoints handled (the only two Claude Desktop hits at runtime):
 *   POST /v1/messages              — chat completion
 *   POST /v1/messages/count_tokens — pre-request token count preview
 *
 * OAuth login flow happens at claude.ai (separate hostname, not intercepted),
 * so the user's Claude Desktop login is unaffected.
 */
async function intercept(req, res, bodyBuffer, mappedModel) {
  try {
    const body = JSON.parse(bodyBuffer.toString());
    if (body.model && mappedModel) body.model = mappedModel;

    const routerPath = req.url.includes("count_tokens")
      ? "/v1/messages/count_tokens"
      : "/v1/messages";

    const routerRes = await fetchRouter(body, routerPath, req.headers);
    await pipeSSE(routerRes, res);
  } catch (error) {
    err(`[claude] ${error.message}`);
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: error.message, type: "mitm_error" } }));
  }
}

module.exports = { intercept };
