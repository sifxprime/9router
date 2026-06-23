// Tier 3.A — cacheControlMode setting unit tests.
//
// Verifies the prepareClaudeRequest(preserveCacheControl=true) flag landed in
// the translator path (translateRequest 12th positional arg) and threads
// through to the cache_control mutation gates.

import { describe, expect, it } from "vitest";
import { prepareClaudeRequest } from "../../open-sse/translator/helpers/claudeHelper.js";

const sampleBody = () => ({
  system: [
    { type: "text", text: "You are a helpful assistant.", cache_control: { type: "ephemeral", ttl: "5m" } },
    { type: "text", text: "Be concise.", cache_control: { type: "ephemeral", ttl: "1h" } },
  ],
  messages: [
    { role: "user", content: [{ type: "text", text: "Hi", cache_control: { type: "ephemeral" } }] },
    { role: "assistant", content: [{ type: "text", text: "Hello!" }] },
  ],
});

describe("prepareClaudeRequest with cacheControlMode flag", () => {
  it("preserveCacheControl=false (default / never mode) STRIPS and rewrites system blocks", () => {
    const body = sampleBody();
    const before0 = body.system[0].cache_control;
    const before1 = body.system[1].cache_control;
    prepareClaudeRequest(body, "claude");
    // First block's cache_control removed
    expect(body.system[0].cache_control).toBeUndefined();
    // Last block's cache_control REWRITTEN to ttl:1h (not preserved as ttl:5m or whatever)
    expect(body.system[body.system.length - 1].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    // Sanity — we did mutate
    expect(body.system[0].cache_control).not.toEqual(before0);
  });

  it("preserveCacheControl=true (always mode) leaves system blocks byte-identical", () => {
    const body = sampleBody();
    const before = JSON.parse(JSON.stringify(body.system));
    prepareClaudeRequest(body, "claude", null, null, /* preserveCacheControl */ true);
    expect(body.system).toEqual(before);
  });

  it("preserveCacheControl=true also leaves message content cache_control intact", () => {
    const body = sampleBody();
    const before = JSON.parse(JSON.stringify(body.messages[0].content[0]));
    prepareClaudeRequest(body, "claude", null, null, true);
    expect(body.messages[0].content[0]).toEqual(before);
  });

  it("preserveCacheControl=false strips cache_control from message content blocks", () => {
    const body = sampleBody();
    expect(body.messages[0].content[0].cache_control).toBeDefined();
    prepareClaudeRequest(body, "claude");
    expect(body.messages[0].content[0].cache_control).toBeUndefined();
  });

  it("preserveCacheControl=true does not add any cache_control where none existed", () => {
    const body = {
      system: [{ type: "text", text: "plain" }], // no cache_control
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    };
    prepareClaudeRequest(body, "claude", null, null, true);
    expect(body.system[0].cache_control).toBeUndefined();
  });

  it("preserveCacheControl=false adds cache_control to last assistant if none present", () => {
    const body = {
      system: [{ type: "text", text: "x" }],
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: [{ type: "text", text: "ok" }] }, // no cache_control
      ],
    };
    prepareClaudeRequest(body, "claude");
    const lastAssistant = body.messages[body.messages.length - 1];
    expect(lastAssistant.content[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("preserveCacheControl=true does NOT add cache_control to last assistant", () => {
    const body = {
      system: [{ type: "text", text: "x" }],
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: [{ type: "text", text: "ok" }] },
      ],
    };
    prepareClaudeRequest(body, "claude", null, null, true);
    const lastAssistant = body.messages[body.messages.length - 1];
    expect(lastAssistant.content[0].cache_control).toBeUndefined();
  });
});
