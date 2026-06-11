import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getProvider } from "../../src/lib/oauth/providers.js";
import { KiroService } from "../../src/lib/oauth/services/kiro.js";

/**
 * Regression tests for Kiro profileArn resolution + API-key auth.
 *
 * profileArn: AWS SSO OIDC (Builder ID / IDC) /token returns no profileArn, so
 * the provider must fetch it from CodeWhisperer ListAvailableProfiles via
 * postExchange and surface it through mapTokens. The response field name varies
 * (`arn` vs `profileArn`) — both must be accepted.
 *
 * api-key: KiroService.validateApiKey resolves a profileArn with the key and
 * returns a credential shaped for persistence with authMethod="api_key".
 */
describe("kiro provider profileArn resolution", () => {
  const kiro = getProvider("kiro");

  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("fetches profileArn via ListAvailableProfiles when SSO token has none", async () => {
    const expectedArn = "arn:aws:codewhisperer:us-east-1:123456789012:profile/ABC";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ profiles: [{ profileArn: expectedArn }] }),
    });

    const tokens = {
      access_token: "aoaAAAA-access",
      refresh_token: "aorAAAA-refresh",
      expires_in: 3600,
      profile_arn: null,
      _region: "us-east-1",
      _authMethod: "idc",
      _clientId: "client-id",
      _clientSecret: "client-secret",
    };

    const extra = await kiro.postExchange(tokens);
    expect(extra.profileArn).toBe(expectedArn);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://codewhisperer.us-east-1.amazonaws.com");
    expect(init.headers["x-amz-target"]).toBe(
      "AmazonCodeWhispererService.ListAvailableProfiles"
    );
    expect(init.headers.Authorization).toBe("Bearer aoaAAAA-access");

    const mapped = kiro.mapTokens(tokens, extra);
    expect(mapped.providerSpecificData.profileArn).toBe(expectedArn);
    expect(mapped.providerSpecificData.authMethod).toBe("idc");
  });

  it("accepts the `arn` response field name (Kiro-Go reference shape)", async () => {
    const expectedArn = "arn:aws:codewhisperer:us-east-1:222:profile/ARNFIELD";
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ profiles: [{ arn: expectedArn }] }),
    });

    const extra = await kiro.postExchange({
      access_token: "access",
      _region: "us-east-1",
    });
    expect(extra.profileArn).toBe(expectedArn);
  });

  it("prefers a profile matching the token region", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        profiles: [
          { profileArn: "arn:aws:codewhisperer:eu-west-1:111:profile/EU" },
          { profileArn: "arn:aws:codewhisperer:us-east-1:111:profile/US" },
        ],
      }),
    });

    const extra = await kiro.postExchange({
      access_token: "access",
      _region: "us-east-1",
    });
    expect(extra.profileArn).toBe(
      "arn:aws:codewhisperer:us-east-1:111:profile/US"
    );
  });

  it("skips the network call when the token already carries a profileArn", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const extra = await kiro.postExchange({
      access_token: "access",
      profile_arn: "arn:aws:codewhisperer:us-east-1:333:profile/EXISTING",
    });
    expect(extra.profileArn).toBe(
      "arn:aws:codewhisperer:us-east-1:333:profile/EXISTING"
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns null profileArn (non-fatal) when ListAvailableProfiles fails", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => "AccessDenied",
    });
    const extra = await kiro.postExchange({
      access_token: "access",
      _region: "us-east-1",
    });
    expect(extra.profileArn).toBeNull();
  });
});

describe("kiro API-key auth (KiroService.validateApiKey)", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("validates an API key and resolves a credential with profileArn", async () => {
    const expectedArn = "arn:aws:codewhisperer:us-east-1:444:profile/KEY";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ profiles: [{ arn: expectedArn }] }),
    });

    const svc = new KiroService();
    const cred = await svc.validateApiKey("  my-secret-key  ");

    expect(cred).toEqual({
      accessToken: "my-secret-key",
      refreshToken: null,
      profileArn: expectedArn,
      region: "us-east-1",
      authMethod: "api_key",
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://codewhisperer.us-east-1.amazonaws.com");
    expect(init.headers.Authorization).toBe("Bearer my-secret-key");
    expect(init.headers["x-amz-target"]).toBe(
      "AmazonCodeWhispererService.ListAvailableProfiles"
    );
  });

  it("rejects an empty API key without a network call", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const svc = new KiroService();
    await expect(svc.validateApiKey("   ")).rejects.toThrow("API key is required");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces a validation error when the key is rejected", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => "Unauthorized",
    });
    const svc = new KiroService();
    await expect(svc.validateApiKey("bad-key")).rejects.toThrow(
      /API key validation failed/
    );
  });
});
