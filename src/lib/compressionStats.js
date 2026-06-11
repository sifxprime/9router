import { getMeta, setMeta } from "./db/helpers/metaStore.js";
import { getAdapter } from "./db/driver.js";

const META_KEY = "compressionStats";
const TOOL_IDS = ["rtk", "caveman", "headroom"];
const PERIOD_MS = { "24h": 86400000, "7d": 604800000, "30d": 2592000000, "60d": 5184000000 };
let writeQueue = Promise.resolve();

function periodToSince(period) {
  if (period === "all") return null;
  const ms = PERIOD_MS[period];
  if (!ms) return new Date(Date.now() - PERIOD_MS["7d"]).toISOString();
  return new Date(Date.now() - ms).toISOString();
}

function normalizeProvider(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function estimateTokensSaved(bytesSaved) {
  return Math.round(toNumber(bytesSaved) / 4);
}

function canEstimateTokenSavings(tool, bytesSaved) {
  return tool !== "caveman" && toNumber(bytesSaved) > 0;
}

function emptyToolStats() {
  return {
    requests: 0,
    hits: 0,
    bytesBefore: 0,
    bytesAfter: 0,
    bytesSaved: 0,
    estimatedTokensSaved: 0,
    tokenSavingsAvailable: false,
    lastUsed: null,
    lastDetail: "",
  };
}

function emptyStats() {
  return {
    updatedAt: null,
    tools: Object.fromEntries(TOOL_IDS.map((tool) => [tool, emptyToolStats()])),
  };
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function normalizeStats(value) {
  const base = emptyStats();
  const parsed = typeof value === "string" && value
    ? JSON.parse(value)
    : (value && typeof value === "object" ? value : {});

  base.updatedAt = parsed.updatedAt || null;
  for (const tool of TOOL_IDS) {
    const input = parsed.tools?.[tool] || {};
    const bytesBefore = toNumber(input.bytesBefore);
    const bytesAfter = toNumber(input.bytesAfter);
    let bytesSaved = toNumber(input.bytesSaved);
    if (!bytesSaved && bytesBefore > bytesAfter) {
      bytesSaved = bytesBefore - bytesAfter;
    }
    const tokenSavingsAvailable = typeof input.tokenSavingsAvailable === "boolean"
      ? input.tokenSavingsAvailable
      : canEstimateTokenSavings(tool, bytesSaved);
    base.tools[tool] = {
      requests: toNumber(input.requests),
      hits: toNumber(input.hits),
      bytesBefore,
      bytesAfter,
      bytesSaved,
      estimatedTokensSaved: tokenSavingsAvailable ? estimateTokensSaved(bytesSaved) : 0,
      tokenSavingsAvailable,
      lastUsed: input.lastUsed || null,
      lastDetail: typeof input.lastDetail === "string" ? input.lastDetail : "",
    };
  }
  return base;
}

export async function getCompressionStats() {
  try {
    const db = await getAdapter();
    // Aggregate in SQL (indexed, scales) instead of scanning every row in JS.
    const rows = db.all(
      `SELECT subsystem,
              COUNT(*) AS requests,
              SUM(bytes_before) AS bytesBefore,
              SUM(bytes_after) AS bytesAfter,
              SUM(CASE WHEN bytes_before > bytes_after THEN bytes_before - bytes_after ELSE 0 END) AS bytesSaved,
              SUM(CASE WHEN bytes_before > bytes_after THEN 1 ELSE 0 END) AS savedRows,
              MAX(timestamp) AS lastUsed
       FROM compressionStats
       GROUP BY subsystem`,
      []
    );

    const base = emptyStats();
    for (const row of rows) {
      const tool = row.subsystem;
      if (!TOOL_IDS.includes(tool)) continue;
      const target = base.tools[tool];
      const bytesBefore = Number(row.bytesBefore) || 0;
      const bytesAfter = Number(row.bytesAfter) || 0;
      const bytesSaved = Number(row.bytesSaved) || 0;
      const requests = Number(row.requests) || 0;
      const savedRows = Number(row.savedRows) || 0;
      target.requests = requests;
      target.bytesBefore = bytesBefore;
      target.bytesAfter = bytesAfter;
      target.bytesSaved = bytesSaved;
      // caveman has no byte savings — count every injection as a hit
      target.hits = tool === "caveman" ? requests : savedRows;
      target.lastUsed = row.lastUsed || null;
      target.tokenSavingsAvailable = canEstimateTokenSavings(tool, bytesSaved);
      target.estimatedTokensSaved = target.tokenSavingsAvailable
        ? estimateTokensSaved(bytesSaved)
        : 0;
      if (row.lastUsed && (!base.updatedAt || row.lastUsed > base.updatedAt)) {
        base.updatedAt = row.lastUsed;
      }
    }

    return base;
  } catch (err) {
    try {
      console.error("[compressionStats] getCompressionStats SQLite failed:", err?.message || err);
      return normalizeStats(await getMeta(META_KEY, null));
    } catch {
      return emptyStats();
    }
  }
}

export async function recordCompressionStats(tool, event = {}) {
  if (!TOOL_IDS.includes(tool)) return getCompressionStats();

  const nextWrite = writeQueue.catch(() => {}).then(async () => {
    const stats = await getCompressionStats();
    const target = stats.tools[tool];
    const bytesBefore = toNumber(event.bytesBefore);
    const bytesAfter = toNumber(event.bytesAfter);
    const explicitSaved = event.bytesSaved == null ? null : toNumber(event.bytesSaved);
    const bytesSaved = explicitSaved == null ? Math.max(0, bytesBefore - bytesAfter) : explicitSaved;
    const hits = toNumber(event.hits ?? (bytesSaved > 0 || event.hit ? 1 : 0));
    const requests = toNumber(event.requests ?? 1) || 1;
    const now = new Date().toISOString();

    target.requests += requests;
    target.hits += hits;
    target.bytesBefore += bytesBefore;
    target.bytesAfter += bytesAfter;
    target.bytesSaved += bytesSaved;
    target.tokenSavingsAvailable = canEstimateTokenSavings(tool, target.bytesSaved);
    target.estimatedTokensSaved = target.tokenSavingsAvailable
      ? estimateTokensSaved(target.bytesSaved)
      : 0;
    target.lastUsed = now;
    if (typeof event.detail === "string") target.lastDetail = event.detail;
    stats.updatedAt = now;

    await setMeta(META_KEY, JSON.stringify(stats));
    return stats;
  });

  writeQueue = nextWrite.catch(() => {});
  return nextWrite.catch(async (err) => {
    try {
      console.error("[compressionStats] Failed to record stats:", err.message);
    } catch {
      // Continue unconditionally if logging also fails (Req 14.4)
    }
    return getCompressionStats();
  });
}

export async function resetCompressionStats() {
  const stats = emptyStats();
  await setMeta(META_KEY, JSON.stringify(stats));
  return stats;
}


/**
 * Save an individual compression stats record to the SQLite compressionStats table.
 * This writes a per-request row (as opposed to the aggregated JSON blob in _meta).
 *
 * @param {object} record
 * @param {string} record.subsystem - 'rtk' | 'headroom' | 'caveman'
 * @param {number} record.bytesBefore - bytes before compression
 * @param {number} record.bytesAfter - bytes after compression
 * @param {string} [record.filterHits] - JSON string of filter names (optional)
 * @param {string} [record.level] - Caveman intensity level (optional)
 * @param {string} [record.provider] - upstream provider id (optional)
 * @param {string} [record.timestamp] - ISO8601 timestamp (defaults to now)
 */
export async function saveCompressionStats(record) {
  try {
    const db = await getAdapter();
    const timestamp = record.timestamp || new Date().toISOString();
    const subsystem = record.subsystem;
    const provider = normalizeProvider(record.provider);
    const bytesBefore = Number(record.bytesBefore) || 0;
    const bytesAfter = Number(record.bytesAfter) || 0;
    const filterHits = record.filterHits || null;
    const level = record.level || null;

    await db.run(
      `INSERT INTO compressionStats(timestamp, subsystem, provider, bytes_before, bytes_after, filter_hits, level) VALUES(?, ?, ?, ?, ?, ?, ?)`,
      [timestamp, subsystem, provider, bytesBefore, bytesAfter, filterHits, level]
    );
  } catch (err) {
    // Stats write failure must never interrupt the request (Req 14.3)
    try {
      console.error("[compressionStats] Failed to save stats record:", err.message);
    } catch {
      // If logging fails, still continue unconditionally (Req 14.4)
    }
  }
}

export async function clearCompressionHistory() {
  try {
    const db = await getAdapter();
    const row = db.get(`SELECT COUNT(*) AS count FROM compressionStats`);
    const deleted = row?.count || 0;
    db.run(`DELETE FROM compressionStats`);
    return deleted;
  } catch (err) {
    try {
      console.error("[compressionStats] Failed to clear history:", err.message);
    } catch { /* continue */ }
    return 0;
  }
}

export async function getFilterLeaderboard({ limit = 20, since } = {}) {
  try {
    const db = await getAdapter();
    const conds = [];
    const params = [];
    if (since) {
      conds.push("timestamp >= ?");
      params.push(since);
    }
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    const rows = db.all(
      `SELECT filter_hits, bytes_before, bytes_after FROM compressionStats ${where} ORDER BY id DESC LIMIT 5000`,
      params
    );

    const totals = {};
    for (const row of rows) {
      if (!row.filter_hits) continue;
      let filters = [];
      try {
        filters = JSON.parse(row.filter_hits);
      } catch {
        continue;
      }
      const saved = Math.max(0, (Number(row.bytes_before) || 0) - (Number(row.bytes_after) || 0));
      for (const filter of filters) {
        if (!filter) continue;
        if (!totals[filter]) totals[filter] = { filter, hits: 0, bytesSaved: 0 };
        totals[filter].hits += 1;
        totals[filter].bytesSaved += saved;
      }
    }

    return Object.values(totals)
      .sort((a, b) => b.bytesSaved - a.bytesSaved)
      .slice(0, limit);
  } catch {
    return [];
  }
}

function emptyProviderBucket(provider) {
  return {
    provider,
    events: 0,
    bytesSaved: 0,
    rtk: { events: 0, bytesSaved: 0 },
    headroom: { events: 0, bytesSaved: 0 },
    caveman: { events: 0, injections: 0 },
    lastUsed: null,
  };
}

/**
 * Aggregate RTK / Headroom / Caveman compression by upstream provider.
 * @param {string} [period] - 24h | 7d | 30d | 60d | all
 * @param {{ provider?: string }} [filter]
 */
export async function getProviderCompressionStats(period = "7d", filter = {}) {
  try {
    const db = await getAdapter();
    const since = periodToSince(period);
    const conds = [];
    const params = [];
    if (since) {
      conds.push("timestamp >= ?");
      params.push(since);
    }
    if (filter.provider) {
      conds.push("provider = ?");
      params.push(filter.provider);
    }
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    const rows = db.all(
      `SELECT timestamp, provider, subsystem, bytes_before, bytes_after, level FROM compressionStats ${where} ORDER BY id ASC`,
      params
    );

    const byProvider = {};
    for (const row of rows) {
      const provider = row.provider || "unknown";
      if (!byProvider[provider]) byProvider[provider] = emptyProviderBucket(provider);

      const bucket = byProvider[provider];
      const subsystem = row.subsystem;
      const bytesSaved = Math.max(0, (Number(row.bytes_before) || 0) - (Number(row.bytes_after) || 0));
      const isCaveman = subsystem === "caveman";

      bucket.events += 1;
      if (!isCaveman) bucket.bytesSaved += bytesSaved;
      bucket.lastUsed = row.timestamp || bucket.lastUsed;

      if (subsystem === "rtk") {
        bucket.rtk.events += 1;
        bucket.rtk.bytesSaved += bytesSaved;
      } else if (subsystem === "headroom") {
        bucket.headroom.events += 1;
        bucket.headroom.bytesSaved += bytesSaved;
      } else if (subsystem === "caveman") {
        bucket.caveman.events += 1;
        bucket.caveman.injections += 1;
      }
    }

    const providers = Object.values(byProvider)
      .sort((a, b) => b.bytesSaved - a.bytesSaved || b.events - a.events);

    return {
      period,
      requests: rows.length,
      providers,
    };
  } catch {
    return { period, requests: 0, providers: [] };
  }
}

/**
 * Retrieve compression stats records from the SQLite table.
 * @param {object} [filter]
 * @param {string} [filter.subsystem] - filter by subsystem
 * @param {string} [filter.provider] - filter by provider
 * @param {string} [filter.since] - ISO8601 timestamp lower bound
 * @param {number} [filter.limit] - max rows to return (default 100)
 * @returns {Promise<Array>}
 */
export async function getCompressionStatsHistory(filter = {}) {
  try {
    const db = await getAdapter();
    const conds = [];
    const params = [];

    if (filter.subsystem) {
      conds.push("subsystem = ?");
      params.push(filter.subsystem);
    }
    if (filter.since) {
      conds.push("timestamp >= ?");
      params.push(filter.since);
    }
    if (filter.provider) {
      conds.push("provider = ?");
      params.push(filter.provider);
    }

    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    const limit = filter.limit || 100;
    params.push(limit);

    return db.all(
      `SELECT id, timestamp, subsystem, provider, bytes_before, bytes_after, filter_hits, level FROM compressionStats ${where} ORDER BY id DESC LIMIT ?`,
      params
    );
  } catch {
    return [];
  }
}
