// Regression test for 0.5.23 — Antigravity's account-level cooldown must use
// Google's precise retryDelay (from JSON body.error.details[].retryDelay)
// instead of falling back to the default short cooldown. Without this, every
// new user request retries the same 1h-locked account once the short
// default cooldown expires (~30s), burning quota every minute.
import { describe, expect, it } from "vitest";

import { AntigravityExecutor } from "../../open-sse/executors/antigravity.js";

function makeResponse(status, contentType = "application/json") {
  // Minimal Response-like shape that parseError needs (no real headers/body access)
  return { status, headers: { get: () => contentType } };
}

const realGoogle429 = JSON.stringify({
  error: {
    code: 429,
    message: "Individual quota reached. Resets in 1h20m6s.",
    status: "RESOURCE_EXHAUSTED",
    details: [
      {
        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        reason: "QUOTA_EXHAUSTED",
        domain: "cloudcode-pa.googleapis.com",
        metadata: { model: "gemini-3.1-pro-low" }
      },
      {
        "@type": "type.googleapis.com/google.rpc.RetryInfo",
        retryDelay: "4806.898817491s"
      }
    ]
  }
});

describe("AntigravityExecutor.parseError", () => {
  const executor = new AntigravityExecutor();

  it("extracts resetsAtMs from RetryInfo.retryDelay (4806s → ~80 min from now)", () => {
    const before = Date.now();
    const parsed = executor.parseError(makeResponse(429), realGoogle429);
    const after = Date.now();

    expect(parsed).not.toBeNull();
    expect(parsed.status).toBe(429);
    // resetsAtMs should be approximately now + 4806 seconds
    const expectedMin = before + 4806 * 1000;
    const expectedMax = after + 4807 * 1000;
    expect(parsed.resetsAtMs).toBeGreaterThanOrEqual(expectedMin);
    expect(parsed.resetsAtMs).toBeLessThanOrEqual(expectedMax);
  });

  it("falls back to text parsing when details[] is missing", () => {
    const bodyText = JSON.stringify({
      error: { code: 429, message: "Resets in 45m30s." }
    });
    const before = Date.now();
    const parsed = executor.parseError(makeResponse(429), bodyText);
    const expectedMs = 45 * 60 * 1000 + 30 * 1000;

    expect(parsed.resetsAtMs).toBeGreaterThanOrEqual(before + expectedMs - 100);
    expect(parsed.resetsAtMs).toBeLessThanOrEqual(before + expectedMs + 1000);
  });

  it("returns null resetsAtMs when no retry info is parseable", () => {
    const bodyText = JSON.stringify({ error: { message: "something unrelated" } });
    const parsed = executor.parseError(makeResponse(429), bodyText);
    expect(parsed.status).toBe(429);
    expect(parsed.resetsAtMs).toBeNull();
  });

  it("returns null for non-rate-limit status codes", () => {
    expect(executor.parseError(makeResponse(400), "{}")).toBeNull();
    expect(executor.parseError(makeResponse(500), "{}")).toBeNull();
  });

  it("also activates on 503 SERVICE_UNAVAILABLE (some Google paths)", () => {
    const parsed = executor.parseError(makeResponse(503), realGoogle429);
    expect(parsed).not.toBeNull();
    expect(parsed.resetsAtMs).toBeGreaterThan(Date.now() + 4000 * 1000);
  });

  it("survives malformed JSON gracefully", () => {
    const parsed = executor.parseError(makeResponse(429), "not json at all");
    expect(parsed.status).toBe(429);
    expect(parsed.resetsAtMs).toBeNull();
  });
});
