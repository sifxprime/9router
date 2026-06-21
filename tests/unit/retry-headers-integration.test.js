// Integration test for smart 429 retry — proves base.js execute() actually
// honors Retry-After / x-ratelimit-reset-* headers across the wire.
//
// Mocks proxyAwareFetch with a stub that returns 429+headers on first call,
// then 200 on retry. Asserts kRouter waits the exact provider-specified time
// (not the generic 2s default), and that the long-lockout path skips retry.
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock proxyAwareFetch BEFORE base.js imports it
const fetchSpy = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchSpy(...args),
}));

import { BaseExecutor } from "../../open-sse/executors/base.js";

class TestExecutor extends BaseExecutor {
  constructor() {
    super("test", {
      baseUrl: "https://example.test/v1/chat/completions",
      format: "openai",
      retry: { 429: { attempts: 2, delayMs: 60000 } }, // 60s generic delay so we can detect header honoring
    });
  }
  buildUrl() { return this.config.baseUrl; }
  buildHeaders() { return { "Content-Type": "application/json" }; }
  transformRequest(_model, body) { return body; }
}

function buildResponse(status, headers = {}, body = "") {
  return {
    status,
    statusText: status === 200 ? "OK" : "Too Many Requests",
    headers: {
      get: (k) => {
        const lower = k.toLowerCase();
        for (const [hk, hv] of Object.entries(headers)) {
          if (hk.toLowerCase() === lower) return hv;
        }
        return null;
      },
    },
    clone() { return buildResponse(status, headers, body); },
    text: async () => body,
  };
}

describe("base.js execute — smart 429 retry-after integration", () => {
  beforeEach(() => { fetchSpy.mockReset(); });

  it("honors short Retry-After header (waits ~1s instead of generic 60s)", async () => {
    fetchSpy
      .mockResolvedValueOnce(buildResponse(429, { "Retry-After": "1" }, '{"error":"rate limited"}'))
      .mockResolvedValueOnce(buildResponse(200, {}, '{"choices":[{"message":{"content":"ok"}}]}'));

    const exec = new TestExecutor();
    const t0 = Date.now();
    const result = await exec.execute({
      model: "gpt-test",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { apiKey: "test" },
    });
    const elapsed = Date.now() - t0;

    expect(result.response.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    // Must have waited ~1s (the Retry-After value), not the generic 60s
    expect(elapsed).toBeGreaterThan(800);
    expect(elapsed).toBeLessThan(3000);
  }, 10000);

  it("honors x-ratelimit-reset-tokens duration (OpenAI format '500ms')", async () => {
    fetchSpy
      .mockResolvedValueOnce(buildResponse(429, { "x-ratelimit-reset-tokens": "500ms" }, "{}"))
      .mockResolvedValueOnce(buildResponse(200, {}, "{}"));

    const exec = new TestExecutor();
    const t0 = Date.now();
    await exec.execute({
      model: "x", body: { messages: [] }, stream: false, credentials: { apiKey: "k" },
    });
    const elapsed = Date.now() - t0;

    // Must wait the floor of 250ms (set by base.js retry honor logic)
    // — provider said 500ms, so should be in 500-1500ms range
    expect(elapsed).toBeGreaterThan(400);
    expect(elapsed).toBeLessThan(2000);
  }, 5000);

  it("honors Anthropic anthropic-ratelimit-tokens-reset ISO timestamp", async () => {
    const future = new Date(Date.now() + 800).toISOString();
    fetchSpy
      .mockResolvedValueOnce(buildResponse(429, { "anthropic-ratelimit-tokens-reset": future }, "{}"))
      .mockResolvedValueOnce(buildResponse(200, {}, "{}"));

    const exec = new TestExecutor();
    const t0 = Date.now();
    await exec.execute({
      model: "claude", body: { messages: [] }, stream: false, credentials: { apiKey: "k" },
    });
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThan(700);
    expect(elapsed).toBeLessThan(2500);
  }, 5000);

  it("skips retry when Retry-After > 60s (long lockout → caller fallback)", async () => {
    fetchSpy.mockResolvedValueOnce(buildResponse(429, { "Retry-After": "300" }, "{}"));

    const exec = new TestExecutor();
    const t0 = Date.now();
    const result = await exec.execute({
      model: "x", body: { messages: [] }, stream: false, credentials: { apiKey: "k" },
    });
    const elapsed = Date.now() - t0;

    // Must NOT retry — only 1 fetch call, returned the 429 immediately
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result.response.status).toBe(429);
    // No long wait — long lockouts skip in-place retry
    expect(elapsed).toBeLessThan(1000);
  }, 5000);

  it("falls back to generic backoff when no headers present", async () => {
    fetchSpy
      .mockResolvedValueOnce(buildResponse(429, {}, "{}"))
      .mockResolvedValueOnce(buildResponse(200, {}, "{}"));

    // Use shorter generic delay for this test
    class FastExec extends TestExecutor {
      constructor() {
        super();
        this.config.retry = { 429: { attempts: 2, delayMs: 200 } };
      }
    }
    const exec = new FastExec();
    const t0 = Date.now();
    const result = await exec.execute({
      model: "x", body: { messages: [] }, stream: false, credentials: { apiKey: "k" },
    });
    const elapsed = Date.now() - t0;

    expect(result.response.status).toBe(200);
    // Should have waited ~generic 200ms, not zero
    expect(elapsed).toBeGreaterThan(150);
    expect(elapsed).toBeLessThan(1000);
  }, 5000);
});
