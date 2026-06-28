import { getProviderConnections, validateApiKey, updateProviderConnection, updateProviderConnectionAtomic, getSettings } from "@/lib/localDb";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { formatRetryAfter, checkFallbackError, isModelLockActive, buildModelLockUpdate, getEarliestModelLockUntil } from "open-sse/services/accountFallback.js";
import { isAccountAboveThreshold, warmQuotaCache, invalidateQuotaCache, recordQuotaCacheHit } from "open-sse/services/quotaPreflight.js";
import { selectAccount, getRoundRobinState, setRoundRobinState } from "open-sse/services/accountSelector.js";
import { rankConnections, scoreOf } from "@/shared/services/connectionHealth";
import { MAX_RATE_LIMIT_COOLDOWN_MS } from "open-sse/config/errorConfig.js";
import { resolveProviderId, FREE_PROVIDERS } from "@/shared/constants/providers.js";
import * as log from "../utils/logger.js";

// Mutex to prevent race conditions during account selection
let selectionMutex = Promise.resolve();

/**
 * Get provider credentials from localDb
 * Filters out unavailable accounts and returns the selected account based on strategy
 * @param {string} provider - Provider name
 * @param {Set<string>|string|null} excludeConnectionIds - Connection ID(s) to exclude (for retry with next account)
 * @param {string|null} model - Model name for per-model rate limit filtering
 */
export async function getProviderCredentials(provider, excludeConnectionIds = null, model = null, options = {}) {
  // Normalize to Set for consistent handling
  const excludeSet = excludeConnectionIds instanceof Set
    ? excludeConnectionIds
    : (excludeConnectionIds ? new Set([excludeConnectionIds]) : new Set());
  const preferredConnectionId = options?.preferredConnectionId || null;
  // Acquire mutex to prevent race conditions
  const currentMutex = selectionMutex;
  let resolveMutex;
  selectionMutex = new Promise(resolve => { resolveMutex = resolve; });

  try {
    await currentMutex;

    // Resolve alias to provider ID (e.g., "kc" -> "kilocode")
    const providerId = resolveProviderId(provider);

    // Inject a virtual connection for no-auth free providers (with optional proxy pool from settings)
    if (FREE_PROVIDERS[providerId]?.noAuth) {
      const settings = await getSettings();
      const override = (settings.providerStrategies || {})[providerId] || {};
      const resolvedProxy = await resolveConnectionProxyConfig({ proxyPoolId: override.proxyPoolId || "" });
      return {
        id: "noauth",
        connectionName: "Public",
        isActive: true,
        accessToken: "public",
        providerSpecificData: {
          connectionProxyEnabled: resolvedProxy.connectionProxyEnabled,
          connectionProxyUrl: resolvedProxy.connectionProxyUrl,
          connectionNoProxy: resolvedProxy.connectionNoProxy,
          connectionProxyPoolId: resolvedProxy.proxyPoolId || null,
          vercelRelayUrl: resolvedProxy.vercelRelayUrl || "",
        },
      };
    }

    const connections = await getProviderConnections({ provider: providerId, isActive: true });
    log.debug("AUTH", `${provider} | total connections: ${connections.length}, excludeIds: ${excludeSet.size > 0 ? [...excludeSet].join(",") : "none"}, model: ${model || "any"}`);

    if (connections.length === 0) {
      log.warn("AUTH", `No credentials for ${provider}`);
      return null;
    }

    // Warm the quota cache for all this provider's connections so the
    // synchronous threshold check below has fresh data on subsequent requests.
    // Fire-and-forget — first request after restart still proceeds without
    // gating (we fail open when cache is cold).
    warmQuotaCache(connections);

    // Filter out model-locked and excluded connections.
    // bypassModelLock=true is used by "Test Connection" flows — we want to actually
    // call upstream to discover the current state of a model, not show cached locks.
    // Quota preflight (0.5.27): also skip connections whose remaining quota for
    // this model is at or below the threshold. Pure cache-lookup, no I/O.
    const quotaSkipped = [];
    const availableConnections = connections.filter(c => {
      if (excludeSet.has(c.id)) return false;
      if (!options.bypassModelLock && isModelLockActive(c, model)) return false;
      if (!options.bypassModelLock && model && !isAccountAboveThreshold(c.provider, c.id, model)) {
        quotaSkipped.push(c.id);
        return false;
      }
      return true;
    });
    if (quotaSkipped.length > 0) {
      log.debug("AUTH", `${provider} | quota-preflight skipped ${quotaSkipped.length} (below threshold): ${quotaSkipped.map(id => id.slice(0,8)).join(",")}`);
    }

    log.debug("AUTH", `${provider} | available: ${availableConnections.length}/${connections.length}`);
    connections.forEach(c => {
      const excluded = excludeSet.has(c.id);
      const locked = isModelLockActive(c, model);
      if (excluded || locked) {
        const lockUntil = getEarliestModelLockUntil(c);
        // 0.5.41 — distinguish per-model lock from account-wide lock. The
        // previous formatter always said "modelLocked(<model>)" which made
        // it look like only one model was locked when in reality the WHOLE
        // account was verify-locked or monthly-quota-locked.
        const allLocked = !!c.modelLock___all && new Date(c.modelLock___all).getTime() > Date.now();
        const lockLabel = locked
          ? (allLocked ? `ACCOUNT-LOCKED until ${lockUntil}` : `modelLocked(${model}) until ${lockUntil}`)
          : "";
        log.debug("AUTH", `  → ${c.id?.slice(0, 8)} | ${excluded ? "excluded" : ""} ${lockLabel}`);
      }
    });

    if (availableConnections.length === 0) {
      // Find earliest lock expiry across all connections for retry timing
      const lockedConns = connections.filter(c => isModelLockActive(c, model));
      const expiries = lockedConns.map(c => getEarliestModelLockUntil(c)).filter(Boolean);
      const earliest = expiries.sort()[0] || null;
      if (earliest) {
        const earliestConn = lockedConns[0];
        log.warn("AUTH", `${provider} | all ${connections.length} accounts locked for ${model || "all"} (${formatRetryAfter(earliest)}) | lastError=${earliestConn?.lastError?.slice(0, 50)}`);
        return {
          allRateLimited: true,
          retryAfter: earliest,
          retryAfterHuman: formatRetryAfter(earliest),
          lastError: earliestConn?.lastError || null,
          lastErrorCode: earliestConn?.errorCode || null
        };
      }
      log.warn("AUTH", `${provider} | all ${connections.length} accounts unavailable`);
      return null;
    }

    const settings = await getSettings();
    // Per-provider strategy overrides global setting
    const providerOverride = (settings.providerStrategies || {})[providerId] || {};
    const strategy = providerOverride.fallbackStrategy || settings.fallbackStrategy || "fill-first";

    let connection;
    // Pin to preferred connection if specified and available
    if (preferredConnectionId) {
      connection = availableConnections.find((c) => c.id === preferredConnectionId);
      if (connection) {
        log.info("AUTH", `${provider} | pinned to ${connection.id?.slice(0, 8)} (${connection.name || connection.email || "unnamed"})`);
      }
    }
    if (connection) {
      // skip strategy
    } else if (strategy === "p2c" || strategy === "random") {
      // 0.5.28 — pluggable strategies via accountSelector. P2C avoids the
      // always-pick-the-same-top-account pattern of fill-first when accounts
      // are at the same health tier. Random is a uniform sampler for testing.
      const { account } = selectAccount(availableConnections, strategy, getRoundRobinState(providerId));
      connection = account;
      if (connection) {
        await updateProviderConnection(connection.id, {
          lastUsedAt: new Date().toISOString(),
          consecutiveUseCount: 1,
        });
      }
    } else if (strategy === "round-robin") {
      const stickyLimit = providerOverride.stickyRoundRobinLimit || settings.stickyRoundRobinLimit || 3;

      // Sort by lastUsed (most recent first) to find current candidate
      const byRecency = [...availableConnections].sort((a, b) => {
        if (!a.lastUsedAt && !b.lastUsedAt) return (a.priority || 999) - (b.priority || 999);
        if (!a.lastUsedAt) return 1;
        if (!b.lastUsedAt) return -1;
        return new Date(b.lastUsedAt) - new Date(a.lastUsedAt);
      });

      const current = byRecency[0];
      const currentCount = current?.consecutiveUseCount || 0;

      if (current && current.lastUsedAt && currentCount < stickyLimit) {
        // Stay with current account
        connection = current;
        // Update lastUsedAt and increment count (await to ensure persistence)
        await updateProviderConnection(connection.id, {
          lastUsedAt: new Date().toISOString(),
          consecutiveUseCount: (connection.consecutiveUseCount || 0) + 1
        });
      } else {
        // Pick the least recently used (excluding current if possible)
        const sortedByOldest = [...availableConnections].sort((a, b) => {
          if (!a.lastUsedAt && !b.lastUsedAt) return (a.priority || 999) - (b.priority || 999);
          if (!a.lastUsedAt) return -1;
          if (!b.lastUsedAt) return 1;
          return new Date(a.lastUsedAt) - new Date(b.lastUsedAt);
        });

        connection = sortedByOldest[0];

        // Update lastUsedAt and reset count to 1 (await to ensure persistence)
        await updateProviderConnection(connection.id, {
          lastUsedAt: new Date().toISOString(),
          consecutiveUseCount: 1
        });
      }
    } else {
      // Default: fill-first, BUT re-rank by observed health within the same
      // priority tier. Connections that have been consistently fast and
      // successful in recent traffic float to the top so the user never has
      // to manually reorder accounts when one starts degrading.
      // For brand-new / never-observed connections the rank is neutral so
      // priority-set order is preserved exactly as before.
      const ranked = rankConnections(availableConnections);
      connection = ranked[0];
      if (ranked[0] !== availableConnections[0]) {
        log.debug("AUTH", `${provider} | health re-rank promoted ${connection.id?.slice(0, 8)} (score ${scoreOf(connection.id).toFixed(0)}) over ${availableConnections[0].id?.slice(0, 8)} (score ${scoreOf(availableConnections[0].id).toFixed(0)})`);
      }
    }

    // 0.5.33 — record hot-path read so the background quota daemon knows
    // this account is in active use and deserves periodic refresh.
    recordQuotaCacheHit(connection.provider, connection.id);

    const resolvedProxy = await resolveConnectionProxyConfig(connection.providerSpecificData || {});

    return {
      authType: connection.authType,
      apiKey: connection.apiKey,
      accessToken: connection.accessToken,
      refreshToken: connection.refreshToken,
      idToken: connection.idToken,
      expiresAt: connection.expiresAt,
      expiresIn: connection.expiresIn,
      lastRefreshAt: connection.lastRefreshAt,
      projectId: connection.projectId,
      connectionName: connection.displayName || connection.name || connection.email || connection.id,
      copilotToken: connection.providerSpecificData?.copilotToken,
      providerSpecificData: {
        ...(connection.providerSpecificData || {}),
        connectionProxyEnabled: resolvedProxy.connectionProxyEnabled,
        connectionProxyUrl: resolvedProxy.connectionProxyUrl,
        connectionNoProxy: resolvedProxy.connectionNoProxy,
        connectionProxyPoolId: resolvedProxy.proxyPoolId || null,
        vercelRelayUrl: resolvedProxy.vercelRelayUrl || "",
      },
      connectionId: connection.id,
      // Include current status for optimization check
      testStatus: connection.testStatus,
      lastError: connection.lastError,
      // Pass full connection for clearAccountError to read modelLock_* keys
      _connection: connection
    };
  } finally {
    if (resolveMutex) resolveMutex();
  }
}

/**
 * Mark account+model as unavailable — locks modelLock_${model} in DB.
 * All errors (429, 401, 5xx, etc.) lock per model, not per account.
 * @param {string} connectionId
 * @param {number} status - HTTP status code from upstream
 * @param {string} errorText
 * @param {string|null} provider
 * @param {string|null} model - The specific model that triggered the error
 * @returns {{ shouldFallback: boolean, cooldownMs: number }}
 */
// Extract a Google verification URL from a 403 "Verify your account" response
// body. When set on the connection's lastError, the dashboard surfaces it as
// a clickable badge so the user knows EXACTLY which URL to click to fix the
// account (instead of staring at "Verify your account to continue." with no
// link). Best-effort regex — degrades to null on parse failure.
function extractVerificationUrl(errorText) {
  if (typeof errorText !== "string" || !errorText.includes("accounts.google.com")) return null;
  const match = errorText.match(/https:\/\/accounts\.google\.com\/signin\/continue\?[^\s"'\\)]+/);
  return match ? match[0] : null;
}

export async function markAccountUnavailable(connectionId, status, errorText, provider = null, model = null, resetsAtMs = null) {
  if (!connectionId || connectionId === "noauth") return { shouldFallback: false, cooldownMs: 0 };

  const reason = typeof errorText === "string" ? errorText.slice(0, 100) : "Provider error";
  const verifyUrl = extractVerificationUrl(typeof errorText === "string" ? errorText : "");

  // Captured by the atomic compute callback so we can return them to the caller.
  let outcome = { shouldFallback: false, cooldownMs: 0 };
  let lockKey = null;
  let connName = connectionId.slice(0, 8);

  const merged = await updateProviderConnectionAtomic(connectionId, (existing) => {
    // Read backoffLevel inside the transaction — fixes the read-modify-write race
    // where two concurrent failures both read level N and both wrote level N+1.
    const backoffLevel = existing?.backoffLevel || 0;
    connName = existing?.displayName || existing?.name || existing?.email || connName;

    let shouldFallback, cooldownMs, newBackoffLevel, accountLock, permanent;
    if (resetsAtMs && resetsAtMs > Date.now()) {
      shouldFallback = true;
      cooldownMs = Math.min(resetsAtMs - Date.now(), MAX_RATE_LIMIT_COOLDOWN_MS);
      newBackoffLevel = 0;
      permanent = false;
    } else {
      ({ shouldFallback, cooldownMs, newBackoffLevel, accountLock, permanent } = checkFallbackError(status, errorText, backoffLevel));
    }

    // 0.5.49 — TPM vs daily-quota disambiguation. Google's `fetchAvailableModels`
    // quota tracker reports DAILY budget. Their chat endpoint enforces a
    // SEPARATE per-minute (TPM) rate limit and, frustratingly, sends back the
    // same "Individual quota reached" 429 body for both. When the quota cache
    // says the account is healthy on its daily budget for this model but we
    // STILL got a 429, we are almost certainly hitting the TPM window —
    // which resets in ~1-3 min, not 30 min. Downgrade the cooldown so the
    // account comes back into rotation fast instead of being parked for half
    // an hour with a misleading "quota exhausted" message.
    const TPM_COOLDOWN_MS = 90 * 1000;
    const TPM_HEALTHY_QUOTA_THRESHOLD = 10;
    const errorTextLower = typeof errorText === "string" ? errorText.toLowerCase() : "";
    const looksLikeQuotaError = errorTextLower.includes("quota reached")
      || errorTextLower.includes("rate limit")
      || errorTextLower.includes("too many requests");

    // 0.5.69 — refuse to downgrade to TPM if Google's message explicitly tells
    // us the reset window is hours/days away. TPM windows reset in seconds-
    // to-minutes; if the upstream says "Resets in 2h27m" it's the daily/weekly
    // bucket, not TPM. Without this guard, stale quota-cache reads kept
    // re-classifying real daily exhaustion as 90-second TPM, so the picker
    // re-tried the dead account every 90 s and spammed the log.
    const hasHoursOrDaysReset = /resets?\s+in\s+\d+h/i.test(errorText || "")
      || /resets?\s+in\s+\d+\s*(?:hour|day)/i.test(errorText || "");

    let isTpmRateLimit = false;
    if (status === 429 && looksLikeQuotaError && provider && model && connectionId && !hasHoursOrDaysReset) {
      // Re-check the cached daily quota for THIS model. If it's well above the
      // skip threshold, the 429 isn't about daily budget — it's TPM.
      const dailyOk = isAccountAboveThreshold(provider, connectionId, model, TPM_HEALTHY_QUOTA_THRESHOLD);
      if (dailyOk) {
        isTpmRateLimit = true;
        cooldownMs = TPM_COOLDOWN_MS;
        shouldFallback = true;
        accountLock = false;
        permanent = false;
        newBackoffLevel = 0;
      }
    }

    // 0.5.69 — when we detect an hours/days reset, force-invalidate the cached
    // quota for this account+model so subsequent picks see fresh data and
    // don't trip the TPM downgrade on the next request to a different model.
    if (hasHoursOrDaysReset && provider && connectionId) {
      try { invalidateQuotaCache(provider, connectionId); } catch { /* ignore */ }
    }

    var _tpmRateLimit_for_reason = isTpmRateLimit;

    // Even on shouldFallback:false, the rule may still set a cooldown so the same
    // broken model isn't re-tried on the next request. Skip the DB write only when
    // no cooldown was specified (legacy default for transient errors).
    if (!shouldFallback && (!cooldownMs || cooldownMs <= 0)) {
      outcome = { shouldFallback: false, cooldownMs: 0 };
      return null; // no DB write
    }

    // accountLock=true (e.g. "Verify your account" 403) → lock ALL models on this
    // account for the cooldown period. No point trying any model — the whole account
    // needs human intervention. Uses modelLock___all which isModelLockActive() checks
    // as a fallback for any model, so the account is skipped entirely by the picker.
    const lockUpdate = accountLock
      ? buildModelLockUpdate(null, cooldownMs)   // null → modelLock___all
      : buildModelLockUpdate(model, cooldownMs);
    lockKey = Object.keys(lockUpdate)[0];
    // Preserve shouldFallback from the rule — deterministic upstream errors
    // (e.g. model 404 NOT_FOUND) set shouldFallback:false so chat.js exits the
    // fallback loop immediately instead of burning every other account.
    outcome = { shouldFallback: shouldFallback === false ? false : true, cooldownMs, accountLock: accountLock || false, permanent: permanent || false };

    // 0.5.47 — wire the permanent flag through. When the upstream signal
    // is a permanent-ban text (verify your account, account suspended,
    // service disabled), set testStatus to "banned" instead of the generic
    // "unavailable". Connection card UI surfaces banned status as a hard
    // red badge with "ACTION REQUIRED" instead of a cooldown countdown.
    const testStatusValue = permanent ? "banned" : "unavailable";

    return {
      ...lockUpdate,
      testStatus: testStatusValue,
      ...(permanent ? { isPermanentlyBanned: true, bannedAt: new Date().toISOString() } : {}),
      // For Google "Verify your account" 403s, embed the clickable verification
      // URL right in lastError so the dashboard Connection card can render it
      // as a "Verify on Google" link. Without this the user just sees the
      // truncated error and has no idea what to do.
      lastError: accountLock && verifyUrl
        ? `Verify your account: ${verifyUrl}`
        : (_tpmRateLimit_for_reason ? `TPM rate-limited (per-minute window) — daily quota healthy, retries in ~90s` : reason),
      errorCode: status,
      lastErrorAt: new Date().toISOString(),
      backoffLevel: newBackoffLevel ?? backoffLevel,
    };
  });

  if (merged && outcome.shouldFallback) {
    // Invalidate the quota preflight cache for this connection so the next
    // request re-fetches fresh upstream numbers instead of waiting up to 60s
    // for the cache to expire. After a 429, the cached "X% remaining" is
    // certainly wrong.
    if (provider) invalidateQuotaCache(provider, connectionId);

    const lockLabel = outcome.accountLock ? "WHOLE ACCOUNT" : lockKey;
    log.warn("AUTH", `${connName} locked ${lockLabel} for ${Math.round(outcome.cooldownMs / 1000)}s [${status}]`);
    // Extra-loud notice for account-level locks — these need human action
    // (clicking Google's verification link), unlike per-model quota locks
    // which auto-clear when the quota resets.
    if (outcome.accountLock) {
      log.warn("AUTH", `🔒 ACCOUNT ${connName} needs verification → ${verifyUrl || "(URL not parsable from error body)"}`);
    }
    if (provider && status && reason) {
      console.error(`❌ ${provider} [${status}]: ${reason}`);
    }
  }

  return outcome;
}

/**
 * Clear account error status on successful request.
 * - Clears modelLock_${model} (the model that just succeeded)
 * - Lazy-cleans any other expired modelLock_* keys
 * - Resets error state only if no active locks remain
 * @param {string} connectionId
 * @param {object} currentConnection - credentials object (has _connection) or raw connection
 * @param {string|null} model - model that succeeded
 */
export async function clearAccountError(connectionId, currentConnection, model = null) {
  if (!connectionId || connectionId === "noauth") return;
  const conn = currentConnection._connection || currentConnection;
  const now = Date.now();
  const allLockKeys = Object.keys(conn).filter(k => k.startsWith("modelLock_"));

  if (!conn.testStatus && !conn.lastError && allLockKeys.length === 0) return;

  // Keys to clear: current model's lock + all expired locks
  const keysToClear = allLockKeys.filter(k => {
    if (model && k === `modelLock_${model}`) return true; // succeeded model
    if (model && k === "modelLock___all") return true;    // account-level lock
    const expiry = conn[k];
    return expiry && new Date(expiry).getTime() <= now;   // expired
  });

  if (keysToClear.length === 0 && conn.testStatus !== "unavailable" && !conn.lastError) return;

  // Check if any active locks remain after clearing
  const remainingActiveLocks = allLockKeys.filter(k => {
    if (keysToClear.includes(k)) return false;
    const expiry = conn[k];
    return expiry && new Date(expiry).getTime() > now;
  });

  const clearObj = Object.fromEntries(keysToClear.map(k => [k, null]));

  // Only reset error state if no active locks remain
  if (remainingActiveLocks.length === 0) {
    Object.assign(clearObj, { testStatus: "active", lastError: null, lastErrorAt: null, backoffLevel: 0 });
  }

  await updateProviderConnection(connectionId, clearObj);
}

/**
 * Extract API key from request headers
 */
export function extractApiKey(request) {
  // Check Authorization header first
  const authHeader = request.headers.get("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }

  // Check Anthropic x-api-key header
  const xApiKey = request.headers.get("x-api-key");
  if (xApiKey) {
    return xApiKey;
  }

  return null;
}

/**
 * Validate API key (optional - for local use can skip)
 */
export async function isValidApiKey(apiKey) {
  if (!apiKey) return false;
  return await validateApiKey(apiKey);
}
