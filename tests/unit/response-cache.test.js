import { describe, it, expect, beforeEach } from "vitest";
import {
  lookupCache,
  saveToCache,
  getCacheStats,
  resetCache,
} from "../../open-sse/services/responseCache.js";

describe("responseCache", () => {
  beforeEach(() => resetCache());

  describe("isCacheable gating", () => {
    it("does not cache streaming requests", () => {
      saveToCache({
        model: "x",
        body: { messages: [{ role: "user", content: "hi" }], stream: true },
        status: 200,
        responseBody: "ok",
      });
      const hit = lookupCache({
        model: "x",
        body: { messages: [{ role: "user", content: "hi" }], stream: true },
      });
      expect(hit).toBeNull();
    });

    it("does not cache high-temperature requests", () => {
      saveToCache({
        model: "x",
        body: { messages: [{ role: "user", content: "hi" }], temperature: 0.9 },
        status: 200,
        responseBody: "ok",
      });
      const hit = lookupCache({
        model: "x",
        body: { messages: [{ role: "user", content: "hi" }], temperature: 0.9 },
      });
      expect(hit).toBeNull();
    });

    it("does not cache tool_choice:required", () => {
      const body = { messages: [{ role: "user", content: "hi" }], tool_choice: "required" };
      saveToCache({ model: "x", body, status: 200, responseBody: "ok" });
      expect(lookupCache({ model: "x", body })).toBeNull();
    });
  });

  describe("hit/miss", () => {
    it("returns null on cold cache", () => {
      const hit = lookupCache({ model: "m1", body: { messages: [{ role: "user", content: "hi" }] } });
      expect(hit).toBeNull();
      expect(getCacheStats().misses).toBe(1);
    });

    it("returns cached entry on second identical request", () => {
      const body = { messages: [{ role: "user", content: "hi" }] };
      saveToCache({ model: "m1", body, status: 200, responseBody: '{"reply":"hello"}' });
      const hit = lookupCache({ model: "m1", body });
      expect(hit).not.toBeNull();
      expect(hit.body).toBe('{"reply":"hello"}');
      expect(getCacheStats().hits).toBe(1);
    });

    it("distinct messages produce different cache entries", () => {
      saveToCache({
        model: "m1",
        body: { messages: [{ role: "user", content: "hi" }] },
        status: 200,
        responseBody: "A",
      });
      saveToCache({
        model: "m1",
        body: { messages: [{ role: "user", content: "bye" }] },
        status: 200,
        responseBody: "B",
      });
      expect(lookupCache({ model: "m1", body: { messages: [{ role: "user", content: "hi" }] } }).body).toBe("A");
      expect(lookupCache({ model: "m1", body: { messages: [{ role: "user", content: "bye" }] } }).body).toBe("B");
    });

    it("different models produce different cache entries", () => {
      const body = { messages: [{ role: "user", content: "hi" }] };
      saveToCache({ model: "model-a", body, status: 200, responseBody: "fromA" });
      saveToCache({ model: "model-b", body, status: 200, responseBody: "fromB" });
      expect(lookupCache({ model: "model-a", body }).body).toBe("fromA");
      expect(lookupCache({ model: "model-b", body }).body).toBe("fromB");
    });
  });

  describe("error responses", () => {
    it("does not cache non-200 responses", () => {
      const body = { messages: [{ role: "user", content: "hi" }] };
      saveToCache({ model: "m1", body, status: 500, responseBody: "server error" });
      expect(lookupCache({ model: "m1", body })).toBeNull();
    });
  });

  describe("TTL expiry", () => {
    it("expired entries return null", () => {
      const body = { messages: [{ role: "user", content: "hi" }] };
      saveToCache({ model: "m1", body, status: 200, responseBody: "ok", ttlMs: 1 });
      // Wait past TTL
      const start = Date.now();
      while (Date.now() - start < 5) { /* spin briefly */ }
      const hit = lookupCache({ model: "m1", body });
      expect(hit).toBeNull();
    });
  });

  describe("stats", () => {
    it("tracks hits and bytes saved", () => {
      const body = { messages: [{ role: "user", content: "hi" }] };
      saveToCache({ model: "m1", body, status: 200, responseBody: "0123456789" });
      lookupCache({ model: "m1", body });
      lookupCache({ model: "m1", body });
      const stats = getCacheStats();
      expect(stats.hits).toBe(2);
      expect(stats.bytesSaved).toBeGreaterThan(0);
    });
  });
});
