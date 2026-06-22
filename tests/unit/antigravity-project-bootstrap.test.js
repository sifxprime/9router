// Tests for antigravityProjectBootstrap (0.5.29).
import { describe, expect, it, beforeEach, vi } from "vitest";

const proxyFetchMock = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => proxyFetchMock(...args),
}));

const {
  ensureAntigravityProject,
  invalidateAntigravityProject,
  _clearProjectCache,
  _getProjectCacheSize,
} = await import("../../open-sse/services/antigravityProjectBootstrap.js");

function mockResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("ensureAntigravityProject", () => {
  beforeEach(() => {
    proxyFetchMock.mockReset();
    _clearProjectCache();
  });

  it("returns the project id from a successful loadCodeAssist", async () => {
    proxyFetchMock.mockResolvedValue(mockResponse(200, { cloudaicompanionProject: "proj-1" }));
    const pid = await ensureAntigravityProject("tok-A");
    expect(pid).toBe("proj-1");
  });

  it("returns null on null/empty token", async () => {
    expect(await ensureAntigravityProject(null)).toBeNull();
    expect(await ensureAntigravityProject("")).toBeNull();
  });

  it("returns null when upstream returns no project id", async () => {
    proxyFetchMock.mockResolvedValue(mockResponse(200, {}));
    expect(await ensureAntigravityProject("tok-X")).toBeNull();
  });

  it("memoizes — second call with same token does NOT re-fetch", async () => {
    proxyFetchMock.mockResolvedValue(mockResponse(200, { cloudaicompanionProject: "proj-1" }));
    await ensureAntigravityProject("tok-mem");
    proxyFetchMock.mockClear();
    const pid2 = await ensureAntigravityProject("tok-mem");
    expect(pid2).toBe("proj-1");
    expect(proxyFetchMock).not.toHaveBeenCalled();
  });

  it("dedupes concurrent calls for the same token", async () => {
    let resolveFetch;
    proxyFetchMock.mockReturnValue(new Promise(r => { resolveFetch = r; }));
    const [p1, p2, p3] = [
      ensureAntigravityProject("tok-dedupe"),
      ensureAntigravityProject("tok-dedupe"),
      ensureAntigravityProject("tok-dedupe"),
    ];
    expect(proxyFetchMock).toHaveBeenCalledTimes(1);
    resolveFetch(mockResponse(200, { cloudaicompanionProject: "proj-dd" }));
    const results = await Promise.all([p1, p2, p3]);
    expect(results).toEqual(["proj-dd", "proj-dd", "proj-dd"]);
  });

  it("extracts project id from object-shaped response", async () => {
    proxyFetchMock.mockResolvedValue(mockResponse(200, { cloudaicompanionProject: { id: "proj-obj" } }));
    expect(await ensureAntigravityProject("tok-obj")).toBe("proj-obj");
  });

  it("returns null when upstream returns non-200", async () => {
    proxyFetchMock.mockResolvedValue(mockResponse(500, {}));
    expect(await ensureAntigravityProject("tok-err")).toBeNull();
  });

  it("invalidateAntigravityProject forces a re-fetch", async () => {
    proxyFetchMock.mockResolvedValue(mockResponse(200, { cloudaicompanionProject: "p1" }));
    await ensureAntigravityProject("tok-inv");
    invalidateAntigravityProject("tok-inv");
    proxyFetchMock.mockClear();
    await ensureAntigravityProject("tok-inv");
    expect(proxyFetchMock).toHaveBeenCalled();
  });

  it("caches different tokens independently", async () => {
    proxyFetchMock
      .mockResolvedValueOnce(mockResponse(200, { cloudaicompanionProject: "A" }))
      .mockResolvedValueOnce(mockResponse(200, { cloudaicompanionProject: "B" }));
    expect(await ensureAntigravityProject("tok-A")).toBe("A");
    expect(await ensureAntigravityProject("tok-B")).toBe("B");
    expect(_getProjectCacheSize()).toBe(2);
  });
});
