// Verify upstream PR #1947 + #1949 port — Antigravity executor strips
// claude-adaptive thinking fields from BOTH body.request and top-level body
// before sending to Google generateContent.
import { describe, expect, it } from "vitest";

import { AntigravityExecutor } from "../../open-sse/executors/antigravity.js";

function transform(body) {
  const executor = new AntigravityExecutor();
  // Antigravity transformRequest expects credentials.email or connectionId for session derivation
  return executor.transformRequest("gemini-3-pro", body, true, {
    connectionId: "test-conn",
    email: "test@example.com",
    accessToken: "fake",
    projectId: "proj-1",
  });
}

describe("AntigravityExecutor blacklist strip", () => {
  const blacklistedKeys = [
    "output_config",
    "thinking",
    "reasoning_effort",
    "reasoning",
    "enable_thinking",
    "thinking_budget",
    "thinkingConfig",
    "stream",
  ];

  it("strips all blacklisted fields from top-level body", () => {
    const body = {
      model: "gemini-3-pro",
      output_config: { mode: "verbose" },
      thinking: { type: "enabled", budget_tokens: 10000 },
      reasoning_effort: "high",
      reasoning: { effort: "medium" },
      enable_thinking: true,
      thinking_budget: 5000,
      stream: true,
      request: {
        contents: [{ role: "user", parts: [{ text: "probe" }] }],
      },
    };

    const result = transform(body);

    for (const key of blacklistedKeys) {
      expect(result[key], `top-level body should not contain ${key}`).toBeUndefined();
    }
  });

  it("strips blacklisted fields from body.request envelope", () => {
    const body = {
      model: "gemini-3-pro",
      request: {
        contents: [{ role: "user", parts: [{ text: "probe" }] }],
        output_config: { mode: "verbose" },
        thinking: { type: "enabled" },
        stream: true,
      },
    };

    const result = transform(body);

    for (const key of blacklistedKeys) {
      expect(result.request?.[key], `body.request should not contain ${key}`).toBeUndefined();
    }
  });

  it("preserves non-blacklisted fields untouched", () => {
    const body = {
      model: "gemini-3-pro",
      thinking: { type: "enabled" },
      request: {
        contents: [{ role: "user", parts: [{ text: "probe" }] }],
      },
    };

    const result = transform(body);

    expect(result.model).toBe("gemini-3-pro");
    expect(result.project).toBe("proj-1");
    // 0.5.29 — userAgent now varies by account type:
    //   gmail.com / googlemail.com → "antigravity" (consumer)
    //   anything else → "jetski" (enterprise / workspace)
    // The fixture email is "test@example.com" → enterprise → "jetski"
    expect(["antigravity", "jetski"]).toContain(result.userAgent);
    expect(result.request).toBeDefined();
    expect(result.request.contents).toEqual([{ role: "user", parts: [{ text: "probe" }] }]);
  });
});
