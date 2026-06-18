import fs from "node:fs";
import path from "path";
import os from "os";

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
  // One-time auto-migration of legacy ~/.9router → ~/.krouter. Idempotent.
  try {
    if (!fs.existsSync(target) && fs.existsSync(legacy)) {
      fs.renameSync(legacy, target);
      console.log(`[dataDir] Migrated data dir: ${legacy} → ${target}`);
    }
  } catch (e) {
    console.warn(`[dataDir] Auto-migration of ${legacy} → ${target} failed (${e.code || e.message}); continuing with ${target}`);
  }
  return target;
}

export function getDataDir() {
  const configured = process.env.DATA_DIR;
  if (!configured) return defaultDir();

  // On Windows, ignore Unix-style absolute paths (e.g. /var/lib/...) that come
  // from a Linux-targeted .env or Docker config — they are not valid here.
  if (process.platform === "win32" && /^\//.test(configured)) {
    console.warn(`[DATA_DIR] '${configured}' is a Unix path on Windows → fallback to default`);
    return defaultDir();
  }

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

export const DATA_DIR = getDataDir();
