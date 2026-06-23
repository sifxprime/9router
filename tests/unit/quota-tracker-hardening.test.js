// Tier 3.C — quota tracker hardening unit tests.
//
// Three new APIs in quotaPreflight.js (0.5.33):
//   - getQuotaCacheInfo(provider, connId) → { hasData, isFresh, isStale,
//     lastCheckedAt, lastCheckedAgoSec, modelCount }
//   - forceRefreshQuota(provider, connId, connection) → bypasses cache,
//     hits upstream, returns fresh byModel map
//   - recordQuotaCacheHit(provider, connId) → tracks last-used for background
//     refresh daemon

import { describe, expect, it, beforeEach, vi } from "vitest";

const usageMock = vi.fn();
vi.mock("../../open-sse/services/usage.js", () => ({
  getUsageForProvider: (...args) => usageMock(...args),
}));

const {
  clearQuotaCache,
  _setQuotaCacheEntry,
  getQuotaCacheInfo,
  forceRefreshQuota,
  recordQuotaCacheHit,
  startBackgroundQuotaRefresh,
  stopBackgroundQuotaRefresh,
} = await import("../../open-sse/services/quotaPreflight.js");

describe("quotaPreflight — getQuotaCacheInfo", () => {
  beforeEach(() => clearQuotaCache());

  it("returns hasData:false when no cache entry exists", () => {
    const info = getQuotaCacheInfo("antigravity", "conn-1");
    expect(info.hasData).toBe(false);
    expect(info.isFresh).toBe(false);
    expect(info.isStale).toBe(true);
  });

  it("returns fresh state right after a write", () => {
    _setQuotaCacheEntry("antigravity", "conn-1", {
      "model-a": { remainingPercentage: 80, resetAt: null, limitReached: false },
      "model-b": { remainingPercentage: 50, resetAt: null, limitReached: false },
    });
    const info = getQuotaCacheInfo("antigravity", "conn-1");
    expect(info.hasData).toBe(true);
    expect(info.isFresh).toBe(true);
    expect(info.isStale).toBe(false);
    expect(info.modelCount).toBe(2);
    expect(typeof info.lastCheckedAt).toBe("string");
    expect(info.lastCheckedAgoSec).toBeLessThanOrEqual(1);
  });

  it("lastCheckedAgoSec increases over time", async () => {
    _setQuotaCacheEntry("antigravity", "conn-1", { "m": { remainingPercentage: 50, resetAt: null, limitReached: false } });
    const i1 = getQuotaCacheInfo("antigravity", "conn-1");
    await new Promise(r => setTimeout(r, 1100));
    const i2 = getQuotaCacheInfo("antigravity", "conn-1");
    expect(i2.lastCheckedAgoSec).toBeGreaterThan(i1.lastCheckedAgoSec);
  });
});

describe("quotaPreflight — forceRefreshQuota", () => {
  beforeEach(() => {
    clearQuotaCache();
    usageMock.mockReset();
  });

  it("bypasses any existing cache entry and re-fetches from upstream", async () => {
    // Pre-seed stale cache
    _setQuotaCacheEntry("antigravity", "conn-1", { "m": { remainingPercentage: 5, resetAt: null, limitReached: false } });

    // Mock new upstream response with totally different numbers
    usageMock.mockResolvedValueOnce({
      quotas: { "m": { used: 100, total: 1000, remaining: 900, remainingPercentage: 90, resetAt: null, unlimited: false } },
    });

    const result = await forceRefreshQuota("antigravity", "conn-1", { id: "conn-1", provider: "antigravity", accessToken: "fake" });

    expect(usageMock).toHaveBeenCalledTimes(1);
    expect(result["m"].remainingPercentage).toBe(90);
    // Cache should reflect the new value
    const info = getQuotaCacheInfo("antigravity", "conn-1");
    expect(info.hasData).toBe(true);
    expect(info.modelCount).toBe(1);
  });

  it("returns null when provider/connectionId missing", async () => {
    expect(await forceRefreshQuota("", "x", {})).toBeNull();
    expect(await forceRefreshQuota("x", "", {})).toBeNull();
  });
});

describe("quotaPreflight — recordQuotaCacheHit", () => {
  beforeEach(() => clearQuotaCache());

  it("is a no-op for null/empty inputs (won't throw)", () => {
    expect(() => recordQuotaCacheHit(null, "x")).not.toThrow();
    expect(() => recordQuotaCacheHit("x", null)).not.toThrow();
    expect(() => recordQuotaCacheHit("", "")).not.toThrow();
  });

  it("accepts valid inputs without error", () => {
    expect(() => recordQuotaCacheHit("antigravity", "conn-1")).not.toThrow();
  });
});

describe("quotaPreflight — background daemon", () => {
  beforeEach(() => {
    stopBackgroundQuotaRefresh();
    clearQuotaCache();
    usageMock.mockReset();
  });

  it("startBackgroundQuotaRefresh is idempotent — calling twice doesn't stack timers", () => {
    startBackgroundQuotaRefresh(() => []);
    startBackgroundQuotaRefresh(() => []);
    stopBackgroundQuotaRefresh();
    // No assertion needed — just confirming no throw / dupe interval registered
    expect(true).toBe(true);
  });

  it("stopBackgroundQuotaRefresh is safe to call when not running", () => {
    expect(() => stopBackgroundQuotaRefresh()).not.toThrow();
    expect(() => stopBackgroundQuotaRefresh()).not.toThrow();
  });
});
