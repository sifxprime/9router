const fs = require("fs");
const path = require("path");
const os = require("os");
const { exec } = require("child_process");

const APP_NAME = "krouter";
const LEGACY_APP_NAME = "9router";

function appNameDir(name) {
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), name);
  }
  return path.join(os.homedir(), `.${name}`);
}

/**
 * After renaming the data dir, fix up system-wide references that pointed at the
 * legacy `~/.9router/mitm/rootCA.crt` path. Without this, `NODE_EXTRA_CA_CERTS`
 * set by an earlier kRouter version (via launchctl setenv on macOS / setx on
 * Windows) still points at the now-renamed file, so npm and any Node child
 * processes warn "Ignoring extra certs ... No such file or directory" and skip
 * trusting the MITM cert.
 *
 * Best-effort: fires the platform command without awaiting it. The current
 * shell still sees the old env value (system commands only affect future
 * processes); kRouter's MITM startup also re-sets this on every server start,
 * which catches anything missed here.
 *
 * @param {string} legacyDir absolute path of the legacy ~/.9router dir before rename
 * @param {string} targetDir absolute path of the new ~/.krouter dir after rename
 */
function migrateNodeExtraCaCerts(legacyDir, targetDir) {
  const newCert = path.join(targetDir, "mitm", "rootCA.crt");
  if (!fs.existsSync(newCert)) return; // nothing to migrate to

  if (process.platform === "darwin") {
    // launchctl setenv affects new GUI processes (Spotlight-launched apps).
    // Quote the path to survive spaces in $HOME.
    exec(`launchctl setenv NODE_EXTRA_CA_CERTS "${newCert}"`, { windowsHide: true }, () => {});
  } else if (process.platform === "win32") {
    // setx writes to HKCU\Environment and broadcasts WM_SETTINGCHANGE — new
    // processes see the updated value; existing shells/services still see the old.
    exec(`setx NODE_EXTRA_CA_CERTS "${newCert}"`, { windowsHide: true }, () => {});
  }
  // Linux has no equivalent single-line mechanism — env vars live in shell rc
  // files the user controls. kRouter's MITM startup sets the var per-process
  // anyway, so this is a no-op there.
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
      migrateNodeExtraCaCerts(legacy, target);
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
