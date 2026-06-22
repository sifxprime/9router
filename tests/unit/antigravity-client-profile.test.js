// Tests for antigravityClientProfile (0.5.29).
import { describe, expect, it } from "vitest";
import {
  normalizeAntigravityClientProfile,
  getAntigravityClientProfile,
  getAntigravityProfileHeaders,
  getAntigravityHeadersForCredentials,
  ANTIGRAVITY_CLIENT_PROFILE_VALUES,
  DEFAULT_ANTIGRAVITY_CLIENT_PROFILE,
  setAntigravityCachedVersion,
  getAntigravityCachedVersion,
} from "../../open-sse/services/antigravityClientProfile.js";

describe("normalizeAntigravityClientProfile", () => {
  it("returns valid profiles unchanged", () => {
    expect(normalizeAntigravityClientProfile("ide")).toBe("ide");
    expect(normalizeAntigravityClientProfile("harness")).toBe("harness");
    expect(normalizeAntigravityClientProfile("credit-probe")).toBe("credit-probe");
  });
  it("falls back to default for invalid input", () => {
    expect(normalizeAntigravityClientProfile("bogus")).toBe(DEFAULT_ANTIGRAVITY_CLIENT_PROFILE);
    expect(normalizeAntigravityClientProfile(null)).toBe(DEFAULT_ANTIGRAVITY_CLIENT_PROFILE);
    expect(normalizeAntigravityClientProfile(42)).toBe(DEFAULT_ANTIGRAVITY_CLIENT_PROFILE);
  });
});

describe("getAntigravityClientProfile from credentials", () => {
  it("reads providerSpecificData.clientProfile", () => {
    expect(getAntigravityClientProfile({ providerSpecificData: { clientProfile: "harness" } })).toBe("harness");
  });
  it("defaults when not set", () => {
    expect(getAntigravityClientProfile({})).toBe("ide");
    expect(getAntigravityClientProfile(null)).toBe("ide");
  });
});

describe("getAntigravityProfileHeaders", () => {
  const token = "test-access-token";

  it("ide profile sets X-Client-Name=antigravity", () => {
    const h = getAntigravityProfileHeaders("ide", token);
    expect(h["X-Client-Name"]).toBe("antigravity");
    expect(h["User-Agent"]).toBe("antigravity");
    expect(h["Authorization"]).toBe(`Bearer ${token}`);
  });

  it("harness profile uses antigravity-harness UA family", () => {
    const h = getAntigravityProfileHeaders("harness", token);
    expect(h["X-Client-Name"]).toBe("antigravity-harness");
    expect(h["User-Agent"]).toMatch(/^antigravity\//);
  });

  it("credit-probe profile sets antigravity-credit-probe UA", () => {
    const h = getAntigravityProfileHeaders("credit-probe", token);
    expect(h["User-Agent"]).toBe("antigravity-credit-probe");
  });

  it("invalid profile name falls back to ide", () => {
    const h = getAntigravityProfileHeaders("bogus", token);
    expect(h["X-Client-Name"]).toBe("antigravity");
  });

  it("all profiles include x-request-source: local (MITM bypass)", () => {
    for (const p of ANTIGRAVITY_CLIENT_PROFILE_VALUES) {
      expect(getAntigravityProfileHeaders(p, token)["x-request-source"]).toBe("local");
    }
  });
});

describe("getAntigravityHeadersForCredentials", () => {
  it("auto-picks profile from credentials", () => {
    const creds = { accessToken: "T", providerSpecificData: { clientProfile: "harness" } };
    const h = getAntigravityHeadersForCredentials(creds);
    expect(h["X-Client-Name"]).toBe("antigravity-harness");
  });
});

describe("setAntigravityCachedVersion", () => {
  it("updates the cached version returned by getter", () => {
    const previous = getAntigravityCachedVersion();
    setAntigravityCachedVersion("9.9.9");
    expect(getAntigravityCachedVersion()).toBe("9.9.9");
    setAntigravityCachedVersion(previous);
  });
});
