// Tests for antigravity429Engine (0.5.29).
import { describe, expect, it, beforeEach } from "vitest";
import {
  classify429,
  decide429,
  recordCreditsFailure,
  isCreditsDisabled,
  resetCreditsFailure,
  _clearCreditsState,
  SHORT_COOLDOWN_MS,
  FULL_QUOTA_COOLDOWN_MS,
} from "../../open-sse/services/antigravity429Engine.js";

describe("classify429", () => {
  it("returns 'quota_exhausted' for individual quota messages", () => {
    expect(classify429("Individual quota reached. Resets in 1h.")).toBe("quota_exhausted");
    expect(classify429("Enable overages")).toBe("quota_exhausted");
    expect(classify429("quota_exhausted")).toBe("quota_exhausted");
  });

  it("returns 'quota_exhausted' for credits messages", () => {
    expect(classify429("Insufficient credits remaining")).toBe("quota_exhausted");
    expect(classify429("credit balance is empty")).toBe("quota_exhausted");
    expect(classify429("resource has been exhausted")).toBe("quota_exhausted");
  });

  it("returns 'rate_limited' for RPM-style messages", () => {
    expect(classify429("Too many requests per minute")).toBe("rate_limited");
    expect(classify429("Rate limit exceeded")).toBe("rate_limited");
    expect(classify429("rate_limit reached")).toBe("rate_limited");
  });

  it("returns 'soft_rate_limit' for transient messages", () => {
    expect(classify429("Try again shortly")).toBe("soft_rate_limit");
    expect(classify429("temporarily unavailable")).toBe("soft_rate_limit");
  });

  it("returns 'unknown' for unrecognized text", () => {
    expect(classify429("Something happened")).toBe("unknown");
    expect(classify429("")).toBe("unknown");
    expect(classify429(null)).toBe("unknown");
  });
});

describe("decide429", () => {
  it("quota_exhausted recommends full_quota_exhausted with 24h cooldown", () => {
    const d = decide429("quota_exhausted", null);
    expect(d.kind).toBe("full_quota_exhausted");
    expect(d.retryAfterMs).toBe(FULL_QUOTA_COOLDOWN_MS);
  });

  it("rate_limited recommends short_cooldown_switch_auth when retryAfter is large", () => {
    const d = decide429("rate_limited", 10 * 60 * 1000); // 10 min
    expect(d.kind).toBe("short_cooldown_switch_auth");
    expect(d.retryAfterMs).toBe(10 * 60 * 1000);
  });

  it("rate_limited recommends soft_retry when retryAfter is small", () => {
    const d = decide429("rate_limited", 2 * 60 * 1000); // 2 min
    expect(d.kind).toBe("soft_retry");
  });

  it("soft_rate_limit recommends instant_retry for short retryAfter", () => {
    const d = decide429("soft_rate_limit", 1000);
    expect(d.kind).toBe("instant_retry_same_auth");
  });

  it("soft_rate_limit recommends soft_retry for longer retryAfter", () => {
    const d = decide429("soft_rate_limit", 5000);
    expect(d.kind).toBe("soft_retry");
  });

  it("unknown defaults to soft_retry with 5s", () => {
    const d = decide429("unknown", null);
    expect(d.kind).toBe("soft_retry");
    expect(d.retryAfterMs).toBe(5000);
  });
});

describe("credits failure tracking", () => {
  beforeEach(() => _clearCreditsState());

  it("returns false until threshold is reached", () => {
    expect(recordCreditsFailure("acct-1")).toBe(false);
    expect(recordCreditsFailure("acct-1")).toBe(false);
  });

  it("returns true on the 3rd consecutive failure (account disabled)", () => {
    recordCreditsFailure("acct-1");
    recordCreditsFailure("acct-1");
    expect(recordCreditsFailure("acct-1")).toBe(true);
  });

  it("isCreditsDisabled reflects the disabled state", () => {
    recordCreditsFailure("acct-1");
    recordCreditsFailure("acct-1");
    recordCreditsFailure("acct-1");
    expect(isCreditsDisabled("acct-1")).toBe(true);
    expect(isCreditsDisabled("other-acct")).toBe(false);
  });

  it("resetCreditsFailure clears the state", () => {
    recordCreditsFailure("acct-1");
    recordCreditsFailure("acct-1");
    recordCreditsFailure("acct-1");
    resetCreditsFailure("acct-1");
    expect(isCreditsDisabled("acct-1")).toBe(false);
  });

  it("handles null authKey gracefully", () => {
    expect(recordCreditsFailure(null)).toBe(false);
    expect(isCreditsDisabled(null)).toBe(false);
  });
});
