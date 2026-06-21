// Regression test for 0.5.22 — MiMo Free upstream only accepts
// model="mimo-auto", so any other name (gpt-4, claude-3.5-sonnet, mimocode,
// "default") used to fail with 400 "Param Incorrect: Not supported model X".
// The executor now force-rewrites body.model to "mimo-auto" in transformRequest.
import { describe, expect, it } from "vitest";

import { MimoFreeExecutor } from "../../open-sse/executors/mimo-free.js";

describe("MimoFreeExecutor model rewrite", () => {
  const executor = new MimoFreeExecutor();

  it("rewrites 'gpt-4' to 'mimo-auto'", () => {
    const result = executor.transformRequest("gpt-4", {
      model: "gpt-4",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result.model).toBe("mimo-auto");
  });

  it("rewrites 'claude-3.5-sonnet' to 'mimo-auto'", () => {
    const result = executor.transformRequest("claude-3.5-sonnet", {
      model: "claude-3.5-sonnet",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result.model).toBe("mimo-auto");
  });

  it("rewrites 'default' alias to 'mimo-auto'", () => {
    const result = executor.transformRequest("default", {
      model: "default",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result.model).toBe("mimo-auto");
  });

  it("leaves 'mimo-auto' unchanged when caller already used it", () => {
    const result = executor.transformRequest("mimo-auto", {
      model: "mimo-auto",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result.model).toBe("mimo-auto");
  });

  it("preserves the anti-abuse system marker injection alongside rewrite", () => {
    const result = executor.transformRequest("gpt-4", {
      model: "gpt-4",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result.model).toBe("mimo-auto");
    expect(result.messages[0].role).toBe("system");
    expect(result.messages.length).toBeGreaterThanOrEqual(2);
  });
});
