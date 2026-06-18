const fs = require("fs");
const path = require("path");
const os = require("os");

const APP_NAME = "krouter";
const LEGACY_APP_NAME = "9router";

function appNameDir(name) {
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), name);
  }
  return path.join(os.homedir(), `.${name}`);
}

function defaultDir() {
  const target = appNameDir(APP_NAME);
  const legacy = appNameDir(LEGACY_APP_NAME);
  // One-time auto-migration: if legacy data dir exists and new one doesn't,
  // rename it. Idempotent — only runs once per machine.
  try {
    if (!fs.existsSync(target) && fs.existsSync(legacy)) {
      fs.renameSync(legacy, target);
      console.log(`[paths] Migrated data dir: ${legacy} → ${target}`);
    }
  } catch (e) {
    console.warn(`[paths] Auto-migration of ${legacy} → ${target} failed (${e.code || e.message}); continuing with ${target}`);
  }
  return target;
}

function getDataDir() {
  const configured = process.env.DATA_DIR;
  if (!configured) return defaultDir();
  try {
    fs.mkdirSync(configured, { recursive: true });
    return configured;
  } catch (e) {
    if (e?.code === "EACCES" || e?.code === "EPERM") {
      console.warn(`[DATA_DIR] '${configured}' not writable → fallback ~/.${APP_NAME}`);
      return defaultDir();
    }
    throw e;
  }
}

const DATA_DIR = getDataDir();
const MITM_DIR = path.join(DATA_DIR, "mitm");

module.exports = { DATA_DIR, MITM_DIR, APP_NAME, LEGACY_APP_NAME };
