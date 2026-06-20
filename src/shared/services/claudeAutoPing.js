// Claude auto-ping scheduler: warms the 5h window by sending a tiny request right after reset.
// Adapted from upstream decolua/9router commits 740093d + 79df34c to our pre-Wave-2 tree:
//   - getClaudeUsage lives in our monolithic open-sse/services/usage.js (not usage/claude.js)
//   - CLAUDE_CLI_SPOOF_HEADERS lives in open-sse/config/providers.js (not providers/shared.js)
import "open-sse/index.js";

import { getSettings, getProviderConnections, updateProviderConnection } from "@/lib/localDb";
import { getClaudeUsage } from "open-sse/services/usage.js";
import { CLAUDE_CLI_SPOOF_HEADERS } from "open-sse/config/providers.js";
import { proxyAwareFetch } from "open-sse/utils/proxyFetch.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { refreshAndUpdateCredentials } from "@/app/api/usage/[connectionId]/route.js";
import { CLAUDE_AUTOPING_CONFIG } from "@/shared/constants/config";

const C = CLAUDE_AUTOPING_CONFIG;
const PING_URL = "https://api.anthropic.com/v1/messages?beta=true";

const g = (global.__claudeAutoPing ??= {
  interval: null,
  running: false,
  resetCache: {},
  // Per-connection "skip until" cache. Set when we observe a disabled_reason
  // on the account (e.g. "out_of_credits", "account_suspended"). Pinging a
  // disabled account is wasted bandwidth — Anthropic will reject the request
  // anyway. Re-check after 1 hour in case the user topped up.
  disabledUntil: {},
  // Per-connection logged-disabled-reason cache so we only log the same
  // disabled_reason once per state-change instead of every tick.
  loggedDisabledReason: {},
});

// Re-probe disabled accounts at most once per hour. Topping up credits or
// switching billing tier can re-enable an account; this gives the change a
// chance to flow through without burning a ping per minute meanwhile.
const DISABLED_RECHECK_MS = 3600000;

function buildProxyOptions(cfg) {
  return {
    connectionProxyEnabled: cfg.connectionProxyEnabled === true,
    connectionProxyUrl: cfg.connectionProxyUrl || "",
    connectionNoProxy: cfg.connectionNoProxy || "",
    vercelRelayUrl: cfg.vercelRelayUrl || "",
    strictProxy: false,
  };
}

async function sendPing(accessToken, proxyOptions) {
  const res = await proxyAwareFetch(PING_URL, {
    method: "POST",
    headers: {
      ...CLAUDE_CLI_SPOOF_HEADERS,
      "Authorization": `Bearer ${accessToken}`,
      "content-type": "application/json",
      // MITM anti-loop — see comment in open-sse/executors/base.js
      "x-request-source": "local",
    },
    body: JSON.stringify({
      model: C.pingModel,
      max_tokens: C.pingMaxTokens,
      messages: [{ role: "user", content: C.pingText }],
    }),
  }, proxyOptions);
  return res.ok;
}

async function pingConnection(conn) {
  // Skip if we recently observed this account is disabled (e.g. out_of_credits).
  // The disabledUntil window expires hourly so a topped-up account auto-resumes.
  const disabledUntil = g.disabledUntil[conn.id];
  if (disabledUntil && Date.now() < disabledUntil) return;

  // Cached resetAt is stable for the whole 5h window; skip usage poll until near reset
  const cachedReset = g.resetCache[conn.id];
  if (cachedReset && Date.now() < new Date(cachedReset).getTime() - C.refreshAheadMs) return;

  const proxyCfg = await resolveConnectionProxyConfig(conn.providerSpecificData);
  const proxyOptions = buildProxyOptions(proxyCfg);

  // Refresh token if needed, then read 5h reset time
  let connection = conn;
  try {
    const r = await refreshAndUpdateCredentials(connection, false, proxyOptions);
    connection = r.connection;
  } catch (e) {
    console.warn(`[AutoPing] ${conn.id}: refresh failed: ${e.message}`);
    return;
  }

  const usage = await getClaudeUsage(connection.accessToken, proxyOptions);

  // Detect a billing-disabled account and short-circuit the ping. Anthropic
  // surfaces this on the OAuth-usage endpoint as `extra_usage.disabled_reason`.
  // Common values: "out_of_credits", "account_suspended". Pinging in this
  // state wastes API calls AND can trigger more aggressive throttling.
  const disabledReason = usage?.extraUsage?.disabled_reason;
  if (disabledReason) {
    g.disabledUntil[conn.id] = Date.now() + DISABLED_RECHECK_MS;
    if (g.loggedDisabledReason[conn.id] !== disabledReason) {
      console.warn(`[AutoPing] ${conn.id}: skipping — Claude account disabled_reason="${disabledReason}". Will re-check in ${DISABLED_RECHECK_MS / 60000}m.`);
      g.loggedDisabledReason[conn.id] = disabledReason;
    }
    return;
  } else if (g.loggedDisabledReason[conn.id]) {
    // Account recovered (credits topped up, suspension lifted) — clear state.
    console.log(`[AutoPing] ${conn.id}: account recovered — auto-ping resumed.`);
    delete g.loggedDisabledReason[conn.id];
    delete g.disabledUntil[conn.id];
  }

  const resetAt = usage?.quotas?.[C.fiveHourKey]?.resetAt;
  if (!resetAt) return;

  g.resetCache[conn.id] = resetAt;

  const resetMs = new Date(resetAt).getTime();
  const now = Date.now();

  // Only ping once per reset cycle, right after window flips
  if (now < resetMs - C.pingLeadMs) return;
  if (connection.lastPingedResetAt === resetAt) return;

  const ok = await sendPing(connection.accessToken, proxyOptions);
  await updateProviderConnection(connection.id, {
    lastPingedResetAt: resetAt,
    lastPingAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  console.log(`[AutoPing] ${connection.id}: ping ${ok ? "sent" : "failed"} (reset ${resetAt})`);
}

async function tick() {
  if (g.running) return;
  g.running = true;
  try {
    const settings = await getSettings();
    const enabledMap = settings[C.settingsKey]?.connections || {};
    if (Object.keys(enabledMap).length === 0) return;

    const conns = await getProviderConnections({ provider: "claude", isActive: true });
    // Only ping connections the user explicitly enabled
    const targets = conns.filter((c) => c.authType === "oauth" && enabledMap[c.id] === true);
    if (targets.length === 0) return;

    for (const conn of targets) {
      try {
        await pingConnection(conn);
      } catch (e) {
        console.warn(`[AutoPing] ${conn.id}: ${e.message}`);
      }
    }
  } catch (e) {
    console.warn("[AutoPing] tick error:", e.message);
  } finally {
    g.running = false;
  }
}

export function startClaudeAutoPing() {
  if (g.interval) return;
  g.interval = setInterval(() => { tick().catch(() => {}); }, C.tickIntervalMs);
  if (g.interval.unref) g.interval.unref();
}
