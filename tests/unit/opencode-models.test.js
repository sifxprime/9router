import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  proxyAwareFetch: vi.fn(),
}));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: mocks.proxyAwareFetch,
}));

const { resolveOpencodeModels, clearOpencodeModelsCache } = await import(
  "../../open-sse/services/opencodeModels.js"
);

const FULL_RESPONSE = {
  object: "list",
  data: [
    { id: "claude-opus-4-8", object: "model" },        // paid — exclude
    { id: "big-pickle", object: "model" },              // free (explicit set)
    { id: "deepseek-v4-flash-free", object: "model" },  // free (suffix)
    { id: "mimo-v2.5-free", object: "model" },          // free (suffix)
    { id: "qwen3.6-plus-free", object: "model" },       // free (suffix)
    { id: "minimax-m3-free", object: "model" },         // free (suffix)
    { id: "nemotron-3-ultra-free", object: "model" },   // free (suffix)
    { id: "north-mini-code-free", object: "model" },    // free (suffix)
    { id: "gpt-5.5", object: "model" },                 // paid — exclude
  ],
};

function mockResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

describe("resolveOpencodeModels", () => {
  beforeEach(() => {
    clearOpencodeModelsCache();
    vi.clearAllMocks();
  });

  it("returns only free models", async () => {
    mocks.proxyAwareFetch.mockResolvedValue(mockResponse(FULL_RESPONSE));
    const result = await resolveOpencodeModels({});
    const ids = result.models.map((m) => m.id);
    expect(ids).toContain("big-pickle");
    expect(ids).toContain("deepseek-v4-flash-free");
    expect(ids).toContain("qwen3.6-plus-free");
    expect(ids).toContain("minimax-m3-free");
    expect(ids).not.toContain("claude-opus-4-8");
    expect(ids).not.toContain("gpt-5.5");
  });

  it("includes all 7 free models from full response", async () => {
    mocks.proxyAwareFetch.mockResolvedValue(mockResponse(FULL_RESPONSE));
    const result = await resolveOpencodeModels({});
    expect(result.models).toHaveLength(7);
  });

  it("returns null on HTTP error", async () => {
    mocks.proxyAwareFetch.mockResolvedValue(mockResponse({}, 500));
    const result = await resolveOpencodeModels({});
    expect(result).toBeNull();
  });

  it("returns null on network exception", async () => {
    mocks.proxyAwareFetch.mockRejectedValue(new Error("ECONNREFUSED"));
    const result = await resolveOpencodeModels({});
    expect(result).toBeNull();
  });

  it("returns empty models array on empty data", async () => {
    mocks.proxyAwareFetch.mockResolvedValue(mockResponse({ data: [] }));
    const result = await resolveOpencodeModels({});
    expect(result).not.toBeNull();
    expect(result.models).toHaveLength(0);
  });

  it("generates display name when name absent", async () => {
    mocks.proxyAwareFetch.mockResolvedValue(
      mockResponse({ data: [{ id: "deepseek-v4-flash-free" }] })
    );
    const result = await resolveOpencodeModels({});
    expect(result.models[0].name).toBe("Deepseek V4 Flash Free");
  });

  it("uses name from API when provided", async () => {
    mocks.proxyAwareFetch.mockResolvedValue(
      mockResponse({ data: [{ id: "big-pickle", name: "Big Pickle" }] })
    );
    const result = await resolveOpencodeModels({});
    expect(result.models[0].name).toBe("Big Pickle");
  });

  it("caches result and skips second fetch", async () => {
    mocks.proxyAwareFetch.mockResolvedValue(mockResponse(FULL_RESPONSE));
    await resolveOpencodeModels({});
    await resolveOpencodeModels({});
    expect(mocks.proxyAwareFetch).toHaveBeenCalledTimes(1);
  });

  it("calls correct URL with x-opencode-client header", async () => {
    mocks.proxyAwareFetch.mockResolvedValue(mockResponse(FULL_RESPONSE));
    await resolveOpencodeModels({});
    const [url, opts] = mocks.proxyAwareFetch.mock.calls[0];
    expect(url).toBe("https://opencode.ai/zen/v1/models");
    expect(opts.headers["x-opencode-client"]).toBe("desktop");
  });

  it("toDisplayName for non-free model omits Free suffix", async () => {
    mocks.proxyAwareFetch.mockResolvedValue(
      mockResponse({ data: [{ id: "big-pickle" }] })
    );
    const result = await resolveOpencodeModels({});
    expect(result.models[0].name).toBe("Big Pickle");
  });

  it("re-fetches after cache expires", async () => {
    mocks.proxyAwareFetch.mockResolvedValue(mockResponse(FULL_RESPONSE));
    await resolveOpencodeModels({});
    expect(mocks.proxyAwareFetch).toHaveBeenCalledTimes(1);

    clearOpencodeModelsCache();
    await resolveOpencodeModels({});
    expect(mocks.proxyAwareFetch).toHaveBeenCalledTimes(2);
  });

  it("handles missing data key in response via fallback to empty array", async () => {
    // Response with no `data` field — should return empty models, not throw
    mocks.proxyAwareFetch.mockResolvedValue(mockResponse({}));
    const result = await resolveOpencodeModels({});
    expect(result).not.toBeNull();
    expect(result.models).toHaveLength(0);
  });

  it("returns null when res.json() throws (malformed body)", async () => {
    mocks.proxyAwareFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError("Unexpected token"); },
    });
    const result = await resolveOpencodeModels({});
    expect(result).toBeNull();
  });
});
