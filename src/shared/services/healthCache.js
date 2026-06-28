import { getProviderConnections, updateProviderConnection } from "@/lib/localDb.js";
import { getEarliestModelLockUntil, isModelLockActive } from "open-sse/services/accountFallback.js";
import * as log from "@/sse/utils/logger.js";

// ============================================================================
// Zenith Health Cache (RAM Layer)
//
// Maintains an in-memory replica of all active providerConnections.
// Eliminates SQLite reads from the hot path during chat routing and fallback.
// ============================================================================

let _cache = new Map(); // providerId -> Array of connection objects
let _lastSyncTime = 0;
const CACHE_TTL_MS = 10 * 1000; // Force full DB sync every 10 seconds

/**
 * Synchronize the in-memory cache with the SQLite database.
 * This runs automatically if the cache is stale.
 */
export async function syncHealthCache() {
  try {
    const allConnections = await getProviderConnections({ isActive: true });
    const newCache = new Map();

    for (const conn of allConnections) {
      if (!newCache.has(conn.provider)) {
        newCache.set(conn.provider, []);
      }
      newCache.get(conn.provider).push(conn);
    }

    _cache = newCache;
    _lastSyncTime = Date.now();
  } catch (error) {
    log.error("HEALTH_CACHE", `Failed to sync with DB: ${error.message}`);
  }
}

/**
 * Get all active, unlocked connections for a provider directly from RAM.
 * Re-syncs from DB only if the cache is older than CACHE_TTL_MS.
 */
export async function getCachedConnections(provider, excludeConnectionIds = new Set(), model = null, bypassModelLock = false) {
  if (Date.now() - _lastSyncTime > CACHE_TTL_MS) {
    await syncHealthCache();
  }

  const connections = _cache.get(provider) || [];

  const available = connections.filter(c => {
    if (excludeConnectionIds && excludeConnectionIds.has(c.id)) return false;
    if (!bypassModelLock && isModelLockActive(c, model)) return false;
    // 0.5.27 quota preflight is kept separate in quotaPreflight.js, handled by caller
    return true;
  });

  return available;
}

/**
 * Apply a lock/error to an account IN MEMORY instantly, then fire an async DB write.
 * This guarantees the next loop iteration (fallback) skips this account immediately
 * without waiting for SQLite.
 */
export function lockAccountInMemory(connectionId, provider, updateData) {
  if (!_cache.has(provider)) return;

  const connections = _cache.get(provider);
  const connIndex = connections.findIndex(c => c.id === connectionId);

  if (connIndex !== -1) {
    // Mutate the in-memory object instantly
    Object.assign(connections[connIndex], updateData);

    // Fire and forget the SQLite write so we don't stall the user
    updateProviderConnection(connectionId, updateData).catch(e => {
      log.error("HEALTH_CACHE", `Async DB write failed for ${connectionId}: ${e.message}`);
    });
  }
}

/**
 * Get a specific connection by ID from the cache.
 */
export async function getCachedConnectionById(connectionId, provider) {
  if (Date.now() - _lastSyncTime > CACHE_TTL_MS) {
    await syncHealthCache();
  }
  const connections = _cache.get(provider) || [];
  return connections.find(c => c.id === connectionId) || null;
}
