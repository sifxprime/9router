// Regression tests for issue #1046: noAuth providers (opencode) missing from /v1/models
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  getCombos: vi.fn(),
  getCustomModels: vi.fn(),
  getModelAliases: vi.fn(),
  getDisabledModels: vi.fn(),
  resolveKiroModels: vi.fn(),
  resolveQoderModels: vi.fn(),
  resolveOpencodeModels: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.getProviderConnections,
  getCombos: mocks.getCombos,
  getCustomModels: mocks.getCustomModels,
  getModelAliases: mocks.getModelAliases,
}));

vi.mock("@/lib/disabledModelsDb", () => ({
  getDisabledModels: mocks.getDisabledModels,
}));

vi.mock("open-sse/services/kiroModels.js", () => ({
  resolveKiroModels: mocks.resolveKiroModels,
}));

vi.mock("open-sse/services/qoderModels.js", () => ({
  resolveQoderModels: mocks.resolveQoderModels,
}));

vi.mock("open-sse/services/opencodeModels.js", () => ({
  resolveOpencodeModels: mocks.resolveOpencodeModels,
  clearOpencodeModelsCache: vi.fn(),
}));

vi.mock("@/shared/constants/models", () => ({
  PROVIDER_MODELS: {
    kr: [{ id: "claude-sonnet-4.5" }],
    oc: [{ id: "big-pickle" }, { id: "deepseek-v4-flash-free" }],
    cc: [{ id: "claude-opus-4" }],
  },
  PROVIDER_ID_TO_ALIAS: { kiro: "kr", opencode: "oc", claude: "cc" },
}));

vi.mock("@/shared/constants/providers", () => ({
  AI_PROVIDERS: {
    kiro:     { serviceKinds: ["llm"] },
    opencode: { noAuth: true, serviceKinds: ["llm"] },
    claude:   { serviceKinds: ["llm"] },
  },
  getProviderAlias: vi.fn((id) => ({ kiro: "kr", opencode: "oc", claude: "cc" })[id] || id),
  isAnthropicCompatibleProvider: vi.fn().mockReturnValue(false),
  isOpenAICompatibleProvider: vi.fn().mockReturnValue(false),
}));

const { buildModelsList } = await import(
  "../../src/app/api/v1/models/route.js"
);

// Kiro has a stored connection; opencode and claude do not.
const KIRO_CONNECTION = {
  provider: "kiro",
  isActive: true,
  accessToken: "tok",
  refreshToken: "ref",
  providerSpecificData: {},
};

describe("noAuth provider injection in buildModelsList", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCombos.mockResolvedValue([]);
    mocks.getCustomModels.mockResolvedValue([]);
    mocks.getModelAliases.mockResolvedValue({});
    mocks.getDisabledModels.mockResolvedValue({});
    mocks.resolveKiroModels.mockResolvedValue(null);
    mocks.resolveOpencodeModels.mockResolvedValue(null); // use static fallback
  });

  it("includes oc/ models when another provider has a stored connection", async () => {
    mocks.getProviderConnections.mockResolvedValue([KIRO_CONNECTION]);

    const models = await buildModelsList(["llm"]);
    const ids = models.map((m) => m.id);

    expect(ids).toContain("oc/big-pickle");
    expect(ids).toContain("oc/deepseek-v4-flash-free");
  });

  it("includes both connected-provider and noAuth-provider models", async () => {
    mocks.getProviderConnections.mockResolvedValue([KIRO_CONNECTION]);

    const models = await buildModelsList(["llm"]);
    const ids = models.map((m) => m.id);

    expect(ids).toContain("kr/claude-sonnet-4.5");
    expect(ids).toContain("oc/big-pickle");
  });

  it("does NOT inject non-noAuth provider without stored connection", async () => {
    // claude (cc/) has no stored connection and noAuth is false — must not appear
    mocks.getProviderConnections.mockResolvedValue([KIRO_CONNECTION]);

    const models = await buildModelsList(["llm"]);
    const ids = models.map((m) => m.id);

    expect(ids).not.toContain("cc/claude-opus-4");
  });

  it("uses live resolver models when resolveOpencodeModels returns catalog", async () => {
    mocks.getProviderConnections.mockResolvedValue([KIRO_CONNECTION]);
    mocks.resolveOpencodeModels.mockResolvedValue({
      models: [{ id: "qwen3.6-plus-free" }, { id: "minimax-m3-free" }],
    });

    const models = await buildModelsList(["llm"]);
    const ids = models.map((m) => m.id);

    // Verify the mock was actually invoked (guards against mock-ordering issues)
    expect(mocks.resolveOpencodeModels).toHaveBeenCalled();
    expect(ids).toContain("oc/qwen3.6-plus-free");
    expect(ids).toContain("oc/minimax-m3-free");
  });

  it("noAuth provider with empty PROVIDER_MODELS entry is NOT injected", async () => {
    mocks.getProviderConnections.mockResolvedValue([KIRO_CONNECTION]);

    const { PROVIDER_MODELS } = await import("@/shared/constants/models");
    const saved = PROVIDER_MODELS.oc;
    Object.defineProperty(PROVIDER_MODELS, "oc", { value: [], configurable: true });

    try {
      const models = await buildModelsList(["llm"]);
      const ids = models.map((m) => m.id);
      expect(ids.some((id) => id.startsWith("oc/"))).toBe(false);
    } finally {
      Object.defineProperty(PROVIDER_MODELS, "oc", { value: saved, configurable: true });
    }
  });
});
