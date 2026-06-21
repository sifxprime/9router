// Regression test for 0.5.22 fix — when Google returns a 429 with a
// retryDelay measured in hours (e.g. "8830.073278635s" = 2h27m), the
// Antigravity executor must NOT fall through into the generic exponential
// backoff that fires 3 more requests on a known-locked account.
//
// Before the fix: a 429 with retryDelay=8830s would log "Retry-After too long"
// then ALSO run 3 generic exponential retries (2s, 4s, 8s) wasting quota.
// After the fix: the executor returns immediately so base.js can lock the
// account and rotate to a different one.
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// Mock the proxyFetch module before importing the executor so the executor
// picks up our mock instead of the real network fetch.
const proxyFetchMock = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => proxyFetchMock(...args),
}));

const { AntigravityExecutor } = await import("../../open-sse/executors/antigravity.js");

describe("AntigravityExecutor long retryDelay fast-fail", () => {
  beforeEach(() => {
    proxyFetchMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function build429WithLongRetry(retrySeconds = 8830.073278635) {
    const body = {
      error: {
        code: 429,
        message: `Individual quota reached. Resets in ${Math.floor(retrySeconds / 3600)}h${Math.floor((retrySeconds % 3600) / 60)}m.`,
        status: "RESOURCE_EXHAUSTED",
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            reason: "QUOTA_EXHAUSTED",
            domain: "cloudcode-pa.googleapis.com",
            metadata: { model: "gemini-pro-agent" }
          },
          {
            "@type": "type.googleapis.com/google.rpc.RetryInfo",
            retryDelay: `${retrySeconds}s`
          }
        ]
      }
    };
    return new Response(JSON.stringify(body), {
      status: 429,
      headers: { "Content-Type": "application/json" }
    });
  }

  it("returns 429 immediately without firing exponential backoff retries", async () => {
    proxyFetchMock.mockResolvedValue(build429WithLongRetry());
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    const executor = new AntigravityExecutor();
    const result = await executor.execute({
      model: "gemini-pro-agent",
      body: { request: { contents: [{ role: "user", parts: [{ text: "hi" }] }] } },
      stream: false,
      credentials: {
        connectionId: "test-conn",
        email: "test@example.com",
        accessToken: "fake",
        projectId: "proj-1",
      },
      signal: undefined,
      log: { debug: () => {} },
    });

    // The fix: response is returned immediately, no extra retries.
    expect(result.response.status).toBe(429);

    // Critical assertion: fetch fired exactly ONCE (not 4x like before).
    // The fast-fail path short-circuits BEFORE the URL fallback loop continues
    // because we return directly instead of falling through to fallback.
    expect(proxyFetchMock).toHaveBeenCalledTimes(1);

    // Critical assertion: no setTimeout was scheduled with a backoff delay
    // (2000ms / 4000ms / 8000ms exponential backoff values).
    const backoffDelays = setTimeoutSpy.mock.calls
      .map(call => call[1])
      .filter(ms => ms === 2000 || ms === 4000 || ms === 8000);
    expect(backoffDelays).toHaveLength(0);
  });

  it("still retries normally on a short retryDelay (under 10s)", async () => {
    // First call: 429 with short retry; second call: success
    proxyFetchMock
      .mockResolvedValueOnce(build429WithLongRetry(3)) // 3 seconds — under MAX_RETRY_AFTER_MS
      .mockResolvedValue(new Response("{}", { status: 200 }));

    const executor = new AntigravityExecutor();
    const result = await executor.execute({
      model: "gemini-pro-agent",
      body: { request: { contents: [{ role: "user", parts: [{ text: "hi" }] }] } },
      stream: false,
      credentials: {
        connectionId: "test-conn",
        email: "test@example.com",
        accessToken: "fake",
        projectId: "proj-1",
      },
      signal: undefined,
      log: { debug: () => {} },
    });

    expect(result.response.status).toBe(200);
    // Should have retried at least once after the short delay
    expect(proxyFetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  }, 15000);
});
