// Regression test for 0.5.25 — Antigravity (and Gemini-CLI) quotas must report
// total=100 with used/remaining as REAL percentage values, not normalized
// to a fake X/1000 scale.
//
// Reason: Google's quota API only returns remainingFraction (0.0-1.0). It
// does NOT tell anyone the actual request count. The old code multiplied
// by 1000 to fit a counter UI, which confused users into thinking 1000 was
// a real cap. The new format matches Claude's quota shape (total=100).
import { describe, expect, it, vi, beforeEach } from "vitest";

const proxyFetchMock = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => proxyFetchMock(...args),
}));

const { getUsageForProvider } = await import("../../open-sse/services/usage.js");

function makeAntigravityUsageResponse() {
  // Mirrors real shape from cloudcode-pa.googleapis.com/v1internal:listQuotas
  return new Response(JSON.stringify({
    models: {
      "gemini-3-flash": {
        displayName: "Gemini 3 Flash",
        quotaInfo: { remainingFraction: 0.75, resetTime: "2026-06-22T20:00:00Z" },
      },
      "gemini-3.1-pro-low": {
        displayName: "Gemini 3.1 Pro (Low)",
        quotaInfo: { remainingFraction: 0.0, resetTime: "2026-06-24T20:00:00Z" },
      },
      "claude-sonnet-4-6": {
        displayName: "Claude Sonnet 4.6",
        quotaInfo: { remainingFraction: 1.0, resetTime: "2026-06-22T20:00:00Z" },
      },
    },
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

describe("getAntigravityUsage — percentage format (0.5.25)", () => {
  beforeEach(() => {
    proxyFetchMock.mockReset();
    // Subscription info call → quota call (in that order)
    proxyFetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ cloudaicompanionProject: "proj-1" }), { status: 200 }))
      .mockResolvedValueOnce(makeAntigravityUsageResponse());
  });

  it("returns total=100 (not 1000) for every model quota", async () => {
    const usage = await getUsageForProvider({
      provider: "antigravity",
      accessToken: "fake-token",
      providerSpecificData: {},
      projectId: "proj-1",
    });
    for (const [model, quota] of Object.entries(usage.quotas)) {
      expect(quota.total, `${model}.total`).toBe(100);
    }
  });

  it("reports 75% remaining as used=25, remaining=75", async () => {
    const usage = await getUsageForProvider({
      provider: "antigravity",
      accessToken: "fake-token",
      providerSpecificData: {},
      projectId: "proj-1",
    });
    const flash = usage.quotas["gemini-3-flash"];
    expect(flash.used).toBe(25);
    expect(flash.remaining).toBe(75);
    expect(flash.remainingPercentage).toBe(75);
  });

  it("reports exhausted quota as used=100, remaining=0", async () => {
    const usage = await getUsageForProvider({
      provider: "antigravity",
      accessToken: "fake-token",
      providerSpecificData: {},
      projectId: "proj-1",
    });
    const exhausted = usage.quotas["gemini-3.1-pro-low"];
    expect(exhausted.used).toBe(100);
    expect(exhausted.remaining).toBe(0);
    expect(exhausted.remainingPercentage).toBe(0);
  });

  it("reports fresh quota as used=0, remaining=100", async () => {
    const usage = await getUsageForProvider({
      provider: "antigravity",
      accessToken: "fake-token",
      providerSpecificData: {},
      projectId: "proj-1",
    });
    const fresh = usage.quotas["claude-sonnet-4-6"];
    expect(fresh.used).toBe(0);
    expect(fresh.remaining).toBe(100);
    expect(fresh.remainingPercentage).toBe(100);
  });

  it("preserves resetAt timestamp from upstream", async () => {
    const usage = await getUsageForProvider({
      provider: "antigravity",
      accessToken: "fake-token",
      providerSpecificData: {},
      projectId: "proj-1",
    });
    expect(usage.quotas["gemini-3-flash"].resetAt).toBe("2026-06-22T20:00:00.000Z");
  });
});
