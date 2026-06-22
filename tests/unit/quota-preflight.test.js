// Tests for the quota-preflight + scoring module added in 0.5.27.
// Covers: usage→model-quota conversion, threshold gating, multi-account best
// score, cache fail-open, and cache invalidation.
import { describe, expect, it, beforeEach } from "vitest";
import {
  convertUsageToModelQuotas,
  isAccountAboveThreshold,
  scoreModelForCombo,
  bestScoreForProviderModel,
  invalidateQuotaCache,
  clearQuotaCache,
  _setQuotaCacheEntry,
} from "../../open-sse/services/quotaPreflight.js";

describe("convertUsageToModelQuotas", () => {
  it("reshapes a healthy usage response into per-model quotas", () => {
    const usage = {
      quotas: {
        "gemini-3-flash": { used: 25, total: 100, remaining: 75, remainingPercentage: 75 },
        "claude-sonnet-4-6": { used: 100, total: 100, remaining: 0, remainingPercentage: 0 },
      },
    };
    const m = convertUsageToModelQuotas(usage);
    expect(m["gemini-3-flash"].remainingPercentage).toBe(75);
    expect(m["claude-sonnet-4-6"].remainingPercentage).toBe(0);
    expect(m["claude-sonnet-4-6"].limitReached).toBe(true);
  });

  it("skips unlimited quotas", () => {
    const usage = {
      quotas: {
        "gpt-4": { used: 0, total: 0, unlimited: true, remainingPercentage: 100 },
        "gemini": { used: 25, total: 100, remainingPercentage: 75 },
      },
    };
    const m = convertUsageToModelQuotas(usage);
    expect(m["gpt-4"]).toBeUndefined();
    expect(m["gemini"]).toBeDefined();
  });

  it("returns null when usage is just an error message", () => {
    expect(convertUsageToModelQuotas({ message: "Auth expired" })).toBeNull();
  });

  it("returns null on malformed input", () => {
    expect(convertUsageToModelQuotas(null)).toBeNull();
    expect(convertUsageToModelQuotas({})).toBeNull();
    expect(convertUsageToModelQuotas({ quotas: "not-an-object" })).toBeNull();
  });
});

describe("isAccountAboveThreshold — cache fail-open semantics", () => {
  beforeEach(() => clearQuotaCache());

  it("returns true when cache is empty (first-time fail-open)", () => {
    expect(isAccountAboveThreshold("antigravity", "acct-1", "gemini-3-flash")).toBe(true);
  });

  it("returns true when account is above threshold", () => {
    _setQuotaCacheEntry("antigravity", "acct-1", {
      "gemini-3-flash": { remainingPercentage: 50, resetAt: null, limitReached: false },
    });
    expect(isAccountAboveThreshold("antigravity", "acct-1", "gemini-3-flash", 2)).toBe(true);
  });

  it("returns false when account is at or below threshold", () => {
    _setQuotaCacheEntry("antigravity", "acct-1", {
      "gemini-3-flash": { remainingPercentage: 1, resetAt: null, limitReached: false },
    });
    expect(isAccountAboveThreshold("antigravity", "acct-1", "gemini-3-flash", 2)).toBe(false);
  });

  it("returns false at exactly the threshold (boundary)", () => {
    _setQuotaCacheEntry("antigravity", "acct-1", {
      "gemini-3-flash": { remainingPercentage: 2, resetAt: null, limitReached: false },
    });
    expect(isAccountAboveThreshold("antigravity", "acct-1", "gemini-3-flash", 2)).toBe(false);
  });

  it("returns true (fail-open) when cache has account but not this specific model", () => {
    _setQuotaCacheEntry("antigravity", "acct-1", {
      "other-model": { remainingPercentage: 0, resetAt: null, limitReached: true },
    });
    expect(isAccountAboveThreshold("antigravity", "acct-1", "gemini-3-flash")).toBe(true);
  });
});

describe("bestScoreForProviderModel — across all accounts", () => {
  beforeEach(() => clearQuotaCache());

  it("returns the max remainingPercentage across multiple accounts", () => {
    _setQuotaCacheEntry("antigravity", "acct-A", {
      "gemini-3-flash": { remainingPercentage: 25, resetAt: null, limitReached: false },
    });
    _setQuotaCacheEntry("antigravity", "acct-B", {
      "gemini-3-flash": { remainingPercentage: 80, resetAt: null, limitReached: false },
    });
    _setQuotaCacheEntry("antigravity", "acct-C", {
      "gemini-3-flash": { remainingPercentage: 50, resetAt: null, limitReached: false },
    });
    expect(bestScoreForProviderModel("antigravity", "gemini-3-flash")).toBe(80);
  });

  it("returns null when no cached account has this model", () => {
    _setQuotaCacheEntry("antigravity", "acct-A", {
      "different-model": { remainingPercentage: 50, resetAt: null, limitReached: false },
    });
    expect(bestScoreForProviderModel("antigravity", "gemini-3-flash")).toBeNull();
  });

  it("ignores other providers' cached entries", () => {
    _setQuotaCacheEntry("nvidia", "n-1", {
      "gemini-3-flash": { remainingPercentage: 99, resetAt: null, limitReached: false },
    });
    expect(bestScoreForProviderModel("antigravity", "gemini-3-flash")).toBeNull();
  });
});

describe("scoreModelForCombo — single-account scoring", () => {
  beforeEach(() => clearQuotaCache());

  it("returns the remainingPercentage when cached", () => {
    _setQuotaCacheEntry("antigravity", "acct-A", {
      "gemini-3-flash": { remainingPercentage: 42, resetAt: null, limitReached: false },
    });
    expect(scoreModelForCombo("antigravity", "acct-A", "gemini-3-flash")).toBe(42);
  });

  it("returns 0 when no cache entry exists", () => {
    expect(scoreModelForCombo("antigravity", "acct-X", "gemini-3-flash")).toBe(0);
  });
});

describe("invalidateQuotaCache", () => {
  beforeEach(() => clearQuotaCache());

  it("removes the cached entry so next preflight refetches", () => {
    _setQuotaCacheEntry("antigravity", "acct-A", {
      "gemini-3-flash": { remainingPercentage: 10, resetAt: null, limitReached: false },
    });
    expect(isAccountAboveThreshold("antigravity", "acct-A", "gemini-3-flash", 50)).toBe(false);
    invalidateQuotaCache("antigravity", "acct-A");
    // After invalidate → fail-open until next fetch
    expect(isAccountAboveThreshold("antigravity", "acct-A", "gemini-3-flash", 50)).toBe(true);
  });
});
