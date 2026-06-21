// Verifies my fix: when an upstream returns 404 NOT_FOUND for a model that no
// longer exists (e.g. Google deleted a Gemini model id), kRouter should:
//   1. Single-model fallback (chat.js inner loop) → STOP iterating accounts
//      for this model. All accounts would return the same 404.
//   2. Combo fallback (combo.js outer loop) → STILL advance to the next combo
//      entry, since the next entry is a DIFFERENT model that may exist.
//   3. Persist a model-level cooldown so the next user request doesn't
//      immediately re-fire the same broken model.
import { describe, expect, it } from "vitest";
import { checkFallbackError } from "../../open-sse/services/accountFallback.js";

describe("checkFallbackError — model NOT_FOUND handling", () => {
  it("classifies 'Requested entity was not found' as shouldFallback:false", () => {
    const out = checkFallbackError(404, "Requested entity was not found.");
    expect(out.shouldFallback).toBe(false);
    expect(out.cooldownMs).toBe(30 * 60 * 1000);
  });

  it("classifies 'NOT_FOUND' status text as shouldFallback:false", () => {
    const out = checkFallbackError(404, '{"error":{"code":404,"status":"NOT_FOUND"}}');
    expect(out.shouldFallback).toBe(false);
  });

  it("classifies OpenAI '404 page not found' as shouldFallback:false", () => {
    const out = checkFallbackError(404, "404 page not found");
    expect(out.shouldFallback).toBe(false);
  });

  it("classifies OpenAI 'The model `xxx` does not exist' as shouldFallback:false", () => {
    const out = checkFallbackError(404, "The model `gpt-4-zomg` does not exist");
    expect(out.shouldFallback).toBe(false);
  });

  it("preserves cooldownMs so subsequent requests don't immediately retry", () => {
    const out = checkFallbackError(404, "Requested entity was not found");
    expect(out.cooldownMs).toBeGreaterThan(15 * 60 * 1000); // 15min+ floor
  });

  it("generic 404 (no NOT_FOUND text) still allows fallback (backward compat)", () => {
    // Generic 404 without our text rules → falls through to status rule → shouldFallback:true
    const out = checkFallbackError(404, "some unrelated 404 error");
    expect(out.shouldFallback).toBe(true);
  });

  it("does NOT break existing rules: rate-limit still uses backoff", () => {
    const out = checkFallbackError(429, "Rate limit exceeded");
    expect(out.shouldFallback).toBe(true);
    expect(out.newBackoffLevel).toBe(1);
  });

  it("does NOT break monthly quota rule", () => {
    const out = checkFallbackError(402, "MONTHLY_REQUEST_COUNT");
    expect(out.shouldFallback).toBe(true);
    expect(out.accountLock).toBe(true);
  });
});
