// Connection health tracker: keeps an in-memory EWMA latency + success rate
// per provider connection so the auth picker can prefer fast/reliable accounts
// without the user manually reordering their connection priorities.
//
// Why in-memory, not DB:
//   - High-frequency updates (every chat response) would thrash SQLite WAL.
//   - The score is a transient view: a 30-min-old EWMA is meaningless under
//     today's network. State is rebuilt from observed traffic within a few
//     minutes of restart.
//   - Avoids cross-process invalidation if we ever shard.
//
// Score semantics:
//   - Each connection gets a HealthScore: { ewmaLatencyMs, successCount,
//     failureCount, lastUpdate }
//   - successRate = success / (success + failure) over a decaying window
//   - score = (successRate * 1000) - (ewmaLatencyMs / 100)
//     Higher is better. 1000+ = consistently fast & successful; <0 = sad.
//   - Connections never observed get a neutral default score so they're tried
//     fairly alongside known-good ones (the alternative — starve them
//     forever — punishes new accounts and prevents the system from learning).
//
// Decay:
//   - On every read, scores older than DECAY_WINDOW_MS are pulled back toward
//     neutral. A connection that briefly hiccups recovers automatically.
//   - On every write, success/failure counts decay using a half-life of 5 min
//     so a single bad day doesn't permanently dump an account.

const EWMA_ALPHA = 0.3;             // weight of the new sample (0..1). Higher = more reactive, less smooth.
const DECAY_WINDOW_MS = 5 * 60_000; // 5 min — old counts halve.
const NEUTRAL_LATENCY_MS = 3000;    // default initial latency for unobserved connections.
const NEUTRAL_SUCCESS_COUNT = 5;    // pretend new connections have a small clean history.
const NEUTRAL_FAILURE_COUNT = 0;

const g = (global.__krouterConnHealth ??= {
  scores: new Map(), // connectionId -> HealthScore
});

function neutralScore(now = Date.now()) {
  return {
    ewmaLatencyMs: NEUTRAL_LATENCY_MS,
    successCount: NEUTRAL_SUCCESS_COUNT,
    failureCount: NEUTRAL_FAILURE_COUNT,
    lastUpdate: now,
  };
}

function decay(record, nowMs) {
  if (!record) return neutralScore(nowMs);
  const ageMs = nowMs - record.lastUpdate;
  if (ageMs < 60_000) return record; // <1 min — fresh, no decay yet
  // Half-life decay on counts every DECAY_WINDOW_MS. successCount and
  // failureCount both halve so the RATIO is preserved but the WEIGHT (recency)
  // is reduced. ewmaLatencyMs creeps back toward neutral over the same window.
  const halves = Math.min(8, ageMs / DECAY_WINDOW_MS); // cap so we don't underflow
  const factor = Math.pow(0.5, halves);
  return {
    ewmaLatencyMs: record.ewmaLatencyMs + (NEUTRAL_LATENCY_MS - record.ewmaLatencyMs) * (1 - factor),
    successCount: Math.max(NEUTRAL_SUCCESS_COUNT, record.successCount * factor + NEUTRAL_SUCCESS_COUNT * (1 - factor)),
    failureCount: Math.max(0, record.failureCount * factor),
    lastUpdate: record.lastUpdate,
  };
}

/**
 * Record an outcome for a connection. Called from chat.js once we know if the
 * request succeeded and how long it took.
 * @param {string} connectionId
 * @param {boolean} success
 * @param {number} latencyMs - request total time including upstream
 */
export function recordOutcome(connectionId, success, latencyMs) {
  if (!connectionId || connectionId === "noauth") return;
  const nowMs = Date.now();
  const decayed = decay(g.scores.get(connectionId), nowMs);

  const newLatency = Math.max(0, Math.min(60_000, latencyMs || NEUTRAL_LATENCY_MS));
  const ewma = success
    ? EWMA_ALPHA * newLatency + (1 - EWMA_ALPHA) * decayed.ewmaLatencyMs
    : decayed.ewmaLatencyMs; // failed requests don't update latency — they're outliers

  g.scores.set(connectionId, {
    ewmaLatencyMs: ewma,
    successCount: decayed.successCount + (success ? 1 : 0),
    failureCount: decayed.failureCount + (success ? 0 : 1),
    lastUpdate: nowMs,
  });
}

/**
 * Compute a current health score for a connection. Higher is better.
 * Returns neutral score for unobserved connections so they get a fair shot.
 */
export function scoreOf(connectionId) {
  if (!connectionId) return 0;
  const nowMs = Date.now();
  const record = decay(g.scores.get(connectionId), nowMs);
  const total = record.successCount + record.failureCount;
  const successRate = total > 0 ? record.successCount / total : 1;
  // Composite score: prefer high success rate, then low latency.
  // 1000-point success contribution + up to ~600-point latency penalty.
  return successRate * 1000 - record.ewmaLatencyMs / 100;
}

/**
 * Rank connections so the healthiest goes first. Stable: connections with the
 * same score keep their input order (so priority-set order survives ties).
 * Returns a new array; does not mutate the input.
 */
export function rankConnections(connections) {
  if (!Array.isArray(connections) || connections.length < 2) return connections || [];
  const scored = connections.map((c, i) => ({ c, i, s: scoreOf(c.id) }));
  scored.sort((a, b) => b.s - a.s || a.i - b.i);
  return scored.map((x) => x.c);
}

/**
 * Snapshot for diagnostics / dashboard.
 */
export function getHealthSnapshot() {
  const nowMs = Date.now();
  const out = {};
  for (const [id, raw] of g.scores.entries()) {
    const decayed = decay(raw, nowMs);
    const total = decayed.successCount + decayed.failureCount;
    out[id] = {
      score: Math.round(scoreOf(id) * 100) / 100,
      ewmaLatencyMs: Math.round(decayed.ewmaLatencyMs),
      successRate: total > 0 ? Math.round((decayed.successCount / total) * 1000) / 10 : null,
      observed: Math.round(total * 10) / 10,
      lastUpdate: decayed.lastUpdate,
    };
  }
  return out;
}

/**
 * Reset all scores. Mainly used by tests.
 */
export function resetHealth() {
  g.scores.clear();
}
