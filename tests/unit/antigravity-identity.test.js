// Tests for antigravityIdentity (0.5.29).
import { describe, expect, it } from "vitest";
import {
  getAntigravityAccountKey,
  isAntigravityEnterpriseAccount,
  getAntigravityEnvelopeUserAgent,
  generateAntigravityRequestId,
  generateAntigravitySessionId,
  deriveAntigravitySessionId,
  getAntigravitySessionId,
  getAntigravityVscodeSessionId,
} from "../../open-sse/services/antigravityIdentity.js";

describe("getAntigravityAccountKey", () => {
  it("prefers email when present", () => {
    expect(getAntigravityAccountKey({ email: "u@gmail.com", connectionId: "c1" })).toBe("u@gmail.com");
  });
  it("falls back to providerSpecificData.email", () => {
    expect(getAntigravityAccountKey({ providerSpecificData: { email: "u@gmail.com" } })).toBe("u@gmail.com");
  });
  it("falls back to connectionId", () => {
    expect(getAntigravityAccountKey({ connectionId: "c1" })).toBe("c1");
  });
  it("returns null on empty input", () => {
    expect(getAntigravityAccountKey(null)).toBeNull();
    expect(getAntigravityAccountKey({})).toBeNull();
    expect(getAntigravityAccountKey({ email: "  " })).toBeNull();
  });
});

describe("isAntigravityEnterpriseAccount + getAntigravityEnvelopeUserAgent", () => {
  it("classifies gmail/googlemail.com as consumer (antigravity UA)", () => {
    expect(isAntigravityEnterpriseAccount({ email: "u@gmail.com" })).toBe(false);
    expect(isAntigravityEnterpriseAccount({ email: "u@googlemail.com" })).toBe(false);
    expect(getAntigravityEnvelopeUserAgent({ email: "u@gmail.com" })).toBe("antigravity");
  });
  it("classifies workspace domains as enterprise (jetski UA)", () => {
    expect(isAntigravityEnterpriseAccount({ email: "u@acme.com" })).toBe(true);
    expect(getAntigravityEnvelopeUserAgent({ email: "u@acme.com" })).toBe("jetski");
  });
  it("treats missing email as consumer (default fallback)", () => {
    expect(isAntigravityEnterpriseAccount({})).toBe(false);
    expect(getAntigravityEnvelopeUserAgent({})).toBe("antigravity");
  });
  it("case-insensitive matching", () => {
    expect(isAntigravityEnterpriseAccount({ email: "U@Gmail.COM" })).toBe(false);
  });
});

describe("generateAntigravityRequestId", () => {
  it("uses 'agent/<ts>/<hex>' format", () => {
    const id = generateAntigravityRequestId();
    expect(id).toMatch(/^agent\/\d+\/[0-9a-f]{8}$/);
  });
  it("produces unique ids on consecutive calls", () => {
    const a = generateAntigravityRequestId();
    const b = generateAntigravityRequestId();
    expect(a).not.toBe(b);
  });
});

describe("generateAntigravitySessionId", () => {
  it("produces a string starting with '-' (18-digit signed int)", () => {
    const id = generateAntigravitySessionId();
    expect(id.startsWith("-")).toBe(true);
    expect(id.length).toBeGreaterThanOrEqual(18);
  });
});

describe("deriveAntigravitySessionId", () => {
  it("returns the same hash for the same input", () => {
    const a = deriveAntigravitySessionId("u@gmail.com");
    const b = deriveAntigravitySessionId("u@gmail.com");
    expect(a).toBe(b);
  });
  it("returns different hashes for different inputs", () => {
    const a = deriveAntigravitySessionId("u1@gmail.com");
    const b = deriveAntigravitySessionId("u2@gmail.com");
    expect(a).not.toBe(b);
  });
  it("returns null for empty input", () => {
    expect(deriveAntigravitySessionId(null)).toBeNull();
    expect(deriveAntigravitySessionId("")).toBeNull();
    expect(deriveAntigravitySessionId("  ")).toBeNull();
  });
});

describe("getAntigravitySessionId — resolution order", () => {
  it("prefers derived from credentials when account key is present", () => {
    const a = getAntigravitySessionId({ email: "u@gmail.com" }, "fallback-id");
    const b = deriveAntigravitySessionId("u@gmail.com");
    expect(a).toBe(b);
  });
  it("uses fallback when no credentials available", () => {
    expect(getAntigravitySessionId(null, "fallback-id")).toBe("fallback-id");
  });
  it("generates a random session id when nothing else available", () => {
    const id = getAntigravitySessionId(null, null);
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });
});

describe("getAntigravityVscodeSessionId", () => {
  it("returns the same value across calls (process-stable)", () => {
    expect(getAntigravityVscodeSessionId()).toBe(getAntigravityVscodeSessionId());
  });
});
