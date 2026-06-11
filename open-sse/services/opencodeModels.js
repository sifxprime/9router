/**
 * OpenCode Free model catalog fetcher.
 * Fetches opencode.ai/zen/v1/models (no auth required), filters to free-tier
 * models, and caches results for 5 minutes.
 */

import { proxyAwareFetch } from "../utils/proxyFetch.js";

const OPENCODE_MODELS_URL = "https://opencode.ai/zen/v1/models";
const FETCH_TIMEOUT_MS = 3_000;
const CACHE_TTL_MS = 5 * 60 * 1000;

// Known free models that don't carry a "-free" suffix
const FREE_MODEL_IDS = new Set(["big-pickle"]);

let catalogCache = null;

function isFreeModel(id) {
  return id.endsWith("-free") || FREE_MODEL_IDS.has(id);
}

function toDisplayName(id) {
  const base = id.replace(/-free$/, "");
  const words = base.split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
  return id.endsWith("-free") ? `${words} Free` : words;
}

/**
 * Resolve OpenCode Free model catalog.
 * Returns { models: [{ id, name }] } or null on failure.
 */
export async function resolveOpencodeModels(_conn, { log = console } = {}) {
  const now = Date.now();
  if (catalogCache && catalogCache.expiresAt > now) {
    return { models: catalogCache.models };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("timeout"), FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await proxyAwareFetch(OPENCODE_MODELS_URL, {
      method: "GET",
      headers: { "x-opencode-client": "desktop" },
      signal: controller.signal,
    });
  } catch (err) {
    log.log(`OpenCode models fetch error: ${err?.message || err}`);
    return null;
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    log.log(`OpenCode models fetch failed: HTTP ${res.status}`);
    return null;
  }

  const json = await res.json().catch(() => null);
  if (!json) return null;

  const models = (json.data || [])
    .filter((m) => typeof m.id === "string" && isFreeModel(m.id))
    .map((m) => ({ id: m.id, name: m.name || toDisplayName(m.id) }));

  catalogCache = { expiresAt: now + CACHE_TTL_MS, models };
  return { models };
}

/** Clear the in-memory cache (for testing). */
export function clearOpencodeModelsCache() {
  catalogCache = null;
}
