// JSON cache for mitmAlias — read by standalone MITM server (no SQLite native binding).
// Source of truth = SQLite kv['mitmAlias']. JSON is a read-replica synced on app start
// and after every UI write.
import fs from "fs";
import path from "path";
import os from "os";

// Resolves to ~/.krouter, falling back to legacy ~/.9router only if the new dir doesn't
// exist yet — paths.js / dataDir.js handle the actual rename on startup.
function _resolveDataDir() {
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  const winBase = path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "krouter");
  const winLegacy = path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "9router");
  const nixBase = path.join(os.homedir(), ".krouter");
  const nixLegacy = path.join(os.homedir(), ".9router");
  if (process.platform === "win32") {
    return fs.existsSync(winBase) || !fs.existsSync(winLegacy) ? winBase : winLegacy;
  }
  return fs.existsSync(nixBase) || !fs.existsSync(nixLegacy) ? nixBase : nixLegacy;
}
const DATA_DIR = _resolveDataDir();

const CACHE_FILE = path.join(DATA_DIR, "mitm", "aliases.json");

function writeAtomic(data) {
  const dir = path.dirname(CACHE_FILE);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${CACHE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, CACHE_FILE);
}

// Sync entire mitmAlias map from DB → JSON file
export async function syncToJson() {
  try {
    const { getMitmAlias } = await import("@/lib/db/repos/aliasRepo.js");
    const all = await getMitmAlias();
    writeAtomic(all || {});
  } catch (e) {
    console.log("[mitmAliasCache] sync failed:", e.message);
  }
}

// Update cache for a single tool after UI saves to DB
export function writeAliasForTool(tool, mappings) {
  try {
    let current = {};
    if (fs.existsSync(CACHE_FILE)) {
      try { current = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")); } catch { /* corrupted → reset */ }
    }
    current[tool] = mappings || {};
    writeAtomic(current);
  } catch (e) {
    console.log("[mitmAliasCache] write failed:", e.message);
  }
}
