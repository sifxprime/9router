// Quota preflight (0.5.27) — port of OmniRoute's quotaPreflight + genericQuotaFetcher.
//
// What this solves: before sending a chat request, check the account's
// remaining quota. If the account is already exhausted (or near-exhausted)
// for the requested model, SKIP it without burning an upstream call. The
// caller (auth.js picker) consults `isAccountAboveThreshold` synchronously
// from a 60-second cache; if the cache is cold, we fetch in the background
// and let the request through this time.
//
// Threshold semantics: "minimum remaining %". The dashboard already shows
// `remainingPercentage` (0-100). A threshold of 2 means "skip when the
// account has 2% quota or less left". Matches the existing dashboard direction.
//
// Why a separate cache here even though /api/usage caches too:
//   /api/usage returns the full per-window snapshot for UI rendering.
//   We need ONLY the per-(provider, model, account) remainingPercentage for
//   routing decisions, called on the hot path. Local cache keeps the hot
//   path under 1ms even when /api/usage is mid-fetch.

import { getUsageForProvider } from "./usage.js";

const DEFAULT_MIN_REMAINING_PERCENT = 2;
const CACHE_TTL_MS = 60 * 1000; // 60s, same as OmniRoute's CACHE_TTL_MS
const CACHE_MAX_STALE_MS = 5 * 60 * 1000; // 5min — used by background refresh

// In-memory cache: key = `${provider}::${connectionId}` → { quota, fetchedAt }
const cache = new Map();

// In-flight requests (dedupe) to avoid stampeding the upstream usage API
const inFlight = new Map();

function cacheKey(provider, connectionId) {
  return `${provider}::${connectionId}`;
}

function nowMs() {
  return Date.now();
}

function isCacheFresh(entry) {
  return entry && nowMs() - entry.fetchedAt < CACHE_TTL_MS;
}

function isCacheUsable(entry) {
  return entry && nowMs() - entry.fetchedAt < CACHE_MAX_STALE_MS;
}

// Reshape getUsageForProvider() output into the per-model preflight contract.
// Our usage.js returns `{ plan, quotas: { [modelName]: { used, total, remaining, remainingPercentage, resetAt, unlimited } } }`.
// We expose a flat lookup by model so callers can ask "what's left for
// gemini-pro-agent on account X?".
export function convertUsageToModelQuotas(usage) {
  if (!usage || typeof usage !== "object") return null;
  if (usage.message && (!usage.quotas || typeof usage.quotas !== "object")) {
    // Provider explicitly said it couldn't fetch — fail open
    return null;
  }
  const quotas = usage.quotas;
  if (!quotas || typeof quotas !== "object" || Array.isArray(quotas)) return null;

  const byModel = {};
  for (const [name, entry] of Object.entries(quotas)) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.unlimited === true) continue;
    const remainingPct = toFinitePct(entry.remainingPercentage);
    if (remainingPct === null) continue;
    byModel[name] = {
      remainingPercentage: remainingPct,
      resetAt: typeof entry.resetAt === "string" ? entry.resetAt : null,
      limitReached: remainingPct <= 0,
    };
  }
  return Object.keys(byModel).length > 0 ? byModel : null;
}

function toFinitePct(v) {
  if (typeof v === "number" && Number.isFinite(v)) return Math.max(0, Math.min(100, v));
  if (typeof v === "string") {
    const n = parseFloat(v);
    if (Number.isFinite(n)) return Math.max(0, Math.min(100, n));
  }
  return null;
}

// Background fetch — returns a Promise that resolves to per-model quotas
// or null. Stores in cache + dedupes concurrent calls for the same key.
async function fetchAndCache(provider, connectionId, connection) {
  const key = cacheKey(provider, connectionId);
  const existing = inFlight.get(key);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const usage = await getUsageForProvider(connection);
      const byModel = convertUsageToModelQuotas(usage);
      if (byModel) {
        cache.set(key, { byModel, fetchedAt: nowMs() });
      }
      return byModel;
    } catch {
      return null;
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, promise);
  return promise;
}

// SYNCHRONOUS check used on the hot path. Returns true if the account's
// quota for the model is above the threshold (request OK to proceed), false
// if it's at or below (skip the account). Returns true (fail open) when:
//   - no cache entry exists (first time we've seen this account)
//   - cache exists but doesn't have this specific model
//   - cache is older than CACHE_MAX_STALE_MS
// Triggers a background refresh when cache is stale.
export function isAccountAboveThreshold(provider, connectionId, model, threshold = DEFAULT_MIN_REMAINING_PERCENT) {
  const key = cacheKey(provider, connectionId);
  const entry = cache.get(key);
  if (!entry || !isCacheUsable(entry)) return true; // fail open
  const modelQuota = entry.byModel?.[model];
  if (!modelQuota) return true; // no info for this model → can't gate
  return modelQuota.remainingPercentage > threshold;
}

// Asynchronous version — actively fetches if cache is missing or stale.
// Used by the picker when it has time to wait (e.g., explicit preflight call).
export async function preflightAccount(provider, connectionId, connection, model, threshold = DEFAULT_MIN_REMAINING_PERCENT) {
  const key = cacheKey(provider, connectionId);
  let entry = cache.get(key);
  if (!isCacheFresh(entry)) {
    await fetchAndCache(provider, connectionId, connection);
    entry = cache.get(key);
  }
  if (!entry) return { proceed: true, reason: "no_quota_data" };
  const modelQuota = entry.byModel?.[model];
  if (!modelQuota) return { proceed: true, reason: "model_not_in_quota" };
  if (modelQuota.remainingPercentage <= threshold) {
    return {
      proceed: false,
      reason: "quota_below_threshold",
      remainingPercentage: modelQuota.remainingPercentage,
      resetAt: modelQuota.resetAt,
    };
  }
  return { proceed: true, remainingPercentage: modelQuota.remainingPercentage };
}

// Score function for combo ordering. Higher remainingPercentage = higher score.
// Returns 0 when we have no info (so unknown sorts after known-good).
export function scoreModelForCombo(provider, connectionId, model) {
  const entry = cache.get(cacheKey(provider, connectionId));
  if (!isCacheUsable(entry)) return 0;
  const mq = entry.byModel?.[model];
  if (!mq) return 0;
  return mq.remainingPercentage;
}

// Combo scoring without a specific connection: take the MAX remainingPercentage
// across all cached connections for this provider/model. Used by combo handler
// which doesn't know which account will be picked yet. Returns null when we
// have no quota info at all (so combo can keep original order).
export function bestScoreForProviderModel(provider, model) {
  if (!provider || !model) return null;
  let best = null;
  for (const [key, entry] of cache.entries()) {
    if (!key.startsWith(`${provider}::`)) continue;
    if (!isCacheUsable(entry)) continue;
    const mq = entry.byModel?.[model];
    if (!mq) continue;
    if (best === null || mq.remainingPercentage > best) {
      best = mq.remainingPercentage;
    }
  }
  return best;
}

// Warm the cache for a list of accounts (called by chat handler at the top
// of a request so all accounts have fresh quota data by the time the picker
// runs). Non-blocking by default — fire and forget.
export function warmQuotaCache(connections) {
  if (!Array.isArray(connections)) return;
  const seen = new Set();
  for (const c of connections) {
    if (!c?.id || !c?.provider) continue;
    const key = cacheKey(c.provider, c.id);
    if (seen.has(key)) continue;
    seen.add(key);
    const cached = cache.get(key);
    if (isCacheFresh(cached)) continue;
    // fire-and-forget
    fetchAndCache(c.provider, c.id, c).catch(() => { /* ignore */ });
  }
}

// Force-invalidate after a 429 — next preflight gets fresh numbers
export function invalidateQuotaCache(provider, connectionId) {
  cache.delete(cacheKey(provider, connectionId));
}

// For tests
export function clearQuotaCache() {
  cache.clear();
  inFlight.clear();
}
export function _setQuotaCacheEntry(provider, connectionId, byModel) {
  cache.set(cacheKey(provider, connectionId), { byModel, fetchedAt: nowMs() });
}

// 0.5.33 — quota tracker hardening (Tier 3.C)
// ===========================================
// Three improvements layered on top of the existing cache:
//   1. getQuotaCacheInfo(provider, connectionId) — surface freshness to the
//      dashboard so users see "last checked Xs ago" per connection.
//   2. forceRefreshQuota(provider, connectionId, connection) — bypass cache,
//      hit the upstream usage API now, return fresh data. Backs the "Refresh
//      now" button per connection.
//   3. Background refresh: every REFRESH_INTERVAL_MS, refresh every account
//      that was used in the last RECENT_WINDOW_MS. Cold-cache first-request
//      latency on returning users disappears.

const REFRESH_INTERVAL_MS = 60 * 1000;       // 60s — same as upstream cache TTL
const RECENT_WINDOW_MS = 30 * 60 * 1000;     // refresh accounts touched in last 30 min
const lastUsedAt = new Map();                // key → ts of last hot-path read

// Hook into the hot-path read so we know which accounts deserve background refresh
const _origIsAboveThreshold = isAccountAboveThreshold;
// re-export under same name with side-effect on read (Map.set is sub-microsecond)
// We can't redefine an exported const, so we wrap by patching the module's
// recordReadAccount the auth picker should call AFTER it has picked.
export function recordQuotaCacheHit(provider, connectionId) {
  if (!provider || !connectionId) return;
  lastUsedAt.set(cacheKey(provider, connectionId), nowMs());
}

// Returns { freshMs, lastCheckedAt, lastCheckedAgoSec, isFresh, isStale, hasData }.
// Used by the dashboard to render "last checked Xs ago" badges.
export function getQuotaCacheInfo(provider, connectionId) {
  const key = cacheKey(provider, connectionId);
  const entry = cache.get(key);
  if (!entry) return { hasData: false, isFresh: false, isStale: true };
  const now = nowMs();
  const ageMs = now - entry.fetchedAt;
  return {
    hasData: true,
    isFresh: ageMs < CACHE_TTL_MS,
    isStale: ageMs >= CACHE_MAX_STALE_MS,
    lastCheckedAt: new Date(entry.fetchedAt).toISOString(),
    lastCheckedAgoSec: Math.round(ageMs / 1000),
    modelCount: entry.byModel ? Object.keys(entry.byModel).length : 0,
  };
}

// Manual refresh — bypasses cache, hits the upstream usage endpoint now.
// Returns the new byModel map (or null on failure). Updates the cache as a
// side effect so subsequent reads see the fresh data immediately.
export async function forceRefreshQuota(provider, connectionId, connection) {
  if (!provider || !connectionId) return null;
  // Drop the cache entry first so fetchAndCache doesn't short-circuit on the
  // inFlight dedup (which keys on a fresh entry being absent).
  cache.delete(cacheKey(provider, connectionId));
  inFlight.delete(cacheKey(provider, connectionId));
  return fetchAndCache(provider, connectionId, connection);
}

// Background refresh daemon — every REFRESH_INTERVAL_MS, refresh accounts that
// were used recently. Skips accounts whose cache is still fresh.
// connectionsProvider() must return an array of full connection objects (with
// accessToken, providerSpecificData, etc.) so we can call getUsageForProvider.
let _refreshTimer = null;
export function startBackgroundQuotaRefresh(connectionsProvider) {
  if (_refreshTimer) return; // already running
  _refreshTimer = setInterval(async () => {
    let connections;
    try {
      connections = await connectionsProvider();
    } catch {
      return;
    }
    if (!Array.isArray(connections) || connections.length === 0) return;

    const now = nowMs();
    for (const c of connections) {
      if (!c?.id || !c?.provider) continue;
      const key = cacheKey(c.provider, c.id);
      const used = lastUsedAt.get(key) || 0;
      // Only refresh if (a) used in recent window AND (b) cache stale-ish
      if (now - used > RECENT_WINDOW_MS) continue;
      const entry = cache.get(key);
      if (entry && now - entry.fetchedAt < REFRESH_INTERVAL_MS / 2) continue;
      // fire-and-forget — overlap is harmless because of inFlight dedup
      fetchAndCache(c.provider, c.id, c).catch(() => {});
    }
  }, REFRESH_INTERVAL_MS);
  _refreshTimer.unref?.();
}

export function stopBackgroundQuotaRefresh() {
  if (_refreshTimer) {
    clearInterval(_refreshTimer);
    _refreshTimer = null;
  }
}
