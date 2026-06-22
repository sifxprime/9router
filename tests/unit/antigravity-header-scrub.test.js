// Tests for antigravityHeaderScrub (0.5.29).
import { describe, expect, it } from "vitest";
import { scrubProxyAndFingerprintHeaders } from "../../open-sse/services/antigravityHeaderScrub.js";

describe("scrubProxyAndFingerprintHeaders", () => {
  it("strips proxy-tracing headers", () => {
    const out = scrubProxyAndFingerprintHeaders({
      "X-Forwarded-For": "10.0.0.1",
      "X-Real-IP": "10.0.0.1",
      "Via": "1.1 proxy",
      "Forwarded": "for=10.0.0.1",
    });
    expect(out["X-Forwarded-For"]).toBeUndefined();
    expect(out["X-Real-IP"]).toBeUndefined();
    expect(out["Via"]).toBeUndefined();
    expect(out["Forwarded"]).toBeUndefined();
  });

  it("strips Stainless SDK fingerprints", () => {
    const out = scrubProxyAndFingerprintHeaders({
      "X-Stainless-Lang": "js",
      "X-Stainless-Os": "MacOS",
      "X-Stainless-Arch": "arm64",
      "X-Title": "Claude Code",
      "Referer": "http://localhost",
    });
    expect(out["X-Stainless-Lang"]).toBeUndefined();
    expect(out["X-Stainless-Os"]).toBeUndefined();
    expect(out["X-Title"]).toBeUndefined();
    expect(out["Referer"]).toBeUndefined();
  });

  it("strips Sec-Ch-* browser fingerprints", () => {
    const out = scrubProxyAndFingerprintHeaders({
      "Sec-Ch-Ua": "...",
      "Sec-Ch-Ua-Mobile": "?0",
      "Sec-Ch-Ua-Platform": "macOS",
      "Sec-Fetch-Mode": "cors",
    });
    expect(out["Sec-Ch-Ua"]).toBeUndefined();
    expect(out["Sec-Ch-Ua-Mobile"]).toBeUndefined();
    expect(out["Sec-Ch-Ua-Platform"]).toBeUndefined();
    expect(out["Sec-Fetch-Mode"]).toBeUndefined();
  });

  it("strips krouter-internal markers", () => {
    const out = scrubProxyAndFingerprintHeaders({
      "X-KRouter-Trace": "abc",
      "Authorization": "Bearer X",
    });
    expect(out["X-KRouter-Trace"]).toBeUndefined();
    expect(out["Authorization"]).toBe("Bearer X");
  });

  it("strips Accept-Encoding entirely (runtime auto-negotiates / decompresses)", () => {
    const out = scrubProxyAndFingerprintHeaders({
      "Accept-Encoding": "gzip, deflate, br, zstd",
    });
    expect(out["Accept-Encoding"]).toBeUndefined();
  });

  it("places Authorization last in the result object", () => {
    const out = scrubProxyAndFingerprintHeaders({
      "Authorization": "Bearer X",
      "User-Agent": "antigravity",
      "Content-Type": "application/json",
    });
    const keys = Object.keys(out);
    expect(keys[keys.length - 1]).toBe("Authorization");
  });

  it("preserves headers it doesn't recognize", () => {
    const out = scrubProxyAndFingerprintHeaders({
      "User-Agent": "antigravity",
      "Content-Type": "application/json",
      "X-Machine-Session-Id": "12345",
    });
    expect(out["User-Agent"]).toBe("antigravity");
    expect(out["Content-Type"]).toBe("application/json");
    expect(out["X-Machine-Session-Id"]).toBe("12345");
  });

  it("handles null / non-object gracefully", () => {
    expect(scrubProxyAndFingerprintHeaders(null)).toBeNull();
    expect(scrubProxyAndFingerprintHeaders(undefined)).toBeUndefined();
  });
});
