import { describe, it, expect } from "vitest";
import { parseRetryAfterHeaders } from "../../open-sse/utils/retryHeaders.js";

// Helper: build a mock Response with headers
function mockResponse(headers) {
  return {
    headers: {
      get: (key) => {
        const lower = key.toLowerCase();
        for (const [k, v] of Object.entries(headers)) {
          if (k.toLowerCase() === lower) return v;
        }
        return null;
      },
    },
  };
}

describe("parseRetryAfterHeaders", () => {
  describe("Retry-After (RFC 7231)", () => {
    it("parses integer seconds", () => {
      const r = parseRetryAfterHeaders(mockResponse({ "Retry-After": "30" }));
      const expected = Date.now() + 30 * 1000;
      expect(r.resetsAtMs).toBeGreaterThan(expected - 1000);
      expect(r.resetsAtMs).toBeLessThan(expected + 1000);
      expect(r.source).toBe("retry-after");
    });

    it("parses HTTP-date format", () => {
      const future = new Date(Date.now() + 60_000).toUTCString();
      const r = parseRetryAfterHeaders(mockResponse({ "Retry-After": future }));
      expect(r.resetsAtMs).toBeGreaterThan(Date.now() + 50_000);
    });

    it("returns null for past HTTP-date", () => {
      const past = new Date(Date.now() - 60_000).toUTCString();
      const r = parseRetryAfterHeaders(mockResponse({ "Retry-After": past }));
      expect(r.resetsAtMs).toBeNull();
    });
  });

  describe("Anthropic ratelimit reset", () => {
    it("parses ISO-8601 datetime", () => {
      const future = new Date(Date.now() + 45_000).toISOString();
      const r = parseRetryAfterHeaders(mockResponse({ "anthropic-ratelimit-tokens-reset": future }));
      expect(r.resetsAtMs).toBeGreaterThan(Date.now() + 40_000);
      expect(r.source).toBe("anthropic-ratelimit-tokens-reset");
    });

    it("picks earliest of requests-reset and tokens-reset", () => {
      const sooner = new Date(Date.now() + 10_000).toISOString();
      const later = new Date(Date.now() + 60_000).toISOString();
      const r = parseRetryAfterHeaders(mockResponse({
        "anthropic-ratelimit-tokens-reset": later,
        "anthropic-ratelimit-requests-reset": sooner,
      }));
      expect(r.source).toBe("anthropic-ratelimit-requests-reset");
      expect(r.resetsAtMs).toBeGreaterThan(Date.now() + 5_000);
      expect(r.resetsAtMs).toBeLessThan(Date.now() + 20_000);
    });
  });

  describe("OpenAI duration formats (x-ratelimit-reset-*)", () => {
    it("parses '500ms'", () => {
      const r = parseRetryAfterHeaders(mockResponse({ "x-ratelimit-reset-requests": "500ms" }));
      expect(r.resetsAtMs).toBeGreaterThan(Date.now() + 300);
      expect(r.resetsAtMs).toBeLessThan(Date.now() + 1000);
    });

    it("parses '6m0s'", () => {
      const r = parseRetryAfterHeaders(mockResponse({ "x-ratelimit-reset-tokens": "6m0s" }));
      const expected = Date.now() + 6 * 60 * 1000;
      expect(r.resetsAtMs).toBeGreaterThan(expected - 1000);
      expect(r.resetsAtMs).toBeLessThan(expected + 1000);
    });

    it("parses '1h2m3s' (compound)", () => {
      const r = parseRetryAfterHeaders(mockResponse({ "x-ratelimit-reset-tokens": "1h2m3s" }));
      const expectedMs = (1 * 3600 + 2 * 60 + 3) * 1000;
      const expected = Date.now() + expectedMs;
      expect(r.resetsAtMs).toBeGreaterThan(expected - 1000);
      expect(r.resetsAtMs).toBeLessThan(expected + 1000);
    });

    it("picks earliest of tokens-reset and requests-reset", () => {
      const r = parseRetryAfterHeaders(mockResponse({
        "x-ratelimit-reset-requests": "60s",
        "x-ratelimit-reset-tokens": "10s",
      }));
      expect(r.source).toBe("x-ratelimit-reset-tokens");
    });
  });

  describe("x-ratelimit-reset (xAI/Groq/Together)", () => {
    it("parses unix-epoch seconds (10-digit)", () => {
      const futureEpochSec = Math.floor((Date.now() + 30_000) / 1000);
      const r = parseRetryAfterHeaders(mockResponse({ "x-ratelimit-reset": String(futureEpochSec) }));
      expect(r.resetsAtMs).toBeGreaterThan(Date.now() + 25_000);
      expect(r.resetsAtMs).toBeLessThan(Date.now() + 35_000);
    });

    it("parses bare seconds as duration", () => {
      const r = parseRetryAfterHeaders(mockResponse({ "x-ratelimit-reset": "12s" }));
      expect(r.resetsAtMs).toBeGreaterThan(Date.now() + 10_000);
      expect(r.resetsAtMs).toBeLessThan(Date.now() + 14_000);
    });
  });

  describe("priority — earliest reset wins across header types", () => {
    it("picks Retry-After (10s) over Anthropic reset (60s)", () => {
      const future = new Date(Date.now() + 60_000).toISOString();
      const r = parseRetryAfterHeaders(mockResponse({
        "Retry-After": "10",
        "anthropic-ratelimit-tokens-reset": future,
      }));
      expect(r.source).toBe("retry-after");
    });
  });

  describe("edge cases", () => {
    it("returns null when no headers present", () => {
      const r = parseRetryAfterHeaders(mockResponse({}));
      expect(r.resetsAtMs).toBeNull();
    });

    it("returns null when input is null/undefined", () => {
      expect(parseRetryAfterHeaders(null).resetsAtMs).toBeNull();
      expect(parseRetryAfterHeaders(undefined).resetsAtMs).toBeNull();
    });

    it("ignores malformed values", () => {
      const r = parseRetryAfterHeaders(mockResponse({ "Retry-After": "not-a-number" }));
      expect(r.resetsAtMs).toBeNull();
    });

    it("works with plain object headers (not just Response)", () => {
      const r = parseRetryAfterHeaders({ "retry-after": "5" });
      expect(r.resetsAtMs).toBeGreaterThan(Date.now() + 3_000);
    });
  });
});
