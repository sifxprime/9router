// Linux-only helper to set / unset NODE_EXTRA_CA_CERTS for the user's shell.
//
// Why: Node.js + Electron apps (Antigravity, Claude Desktop on Linux, VS Code
// extensions, etc.) read their OWN bundled Mozilla CA store, not the OS trust
// store. Even after we install the kRouter root CA via update-ca-certificates,
// these apps still reject our self-signed cert with
//     x509: certificate signed by unknown authority
// or
//     self signed certificate in certificate chain
//
// macOS solves this via `launchctl setenv NODE_EXTRA_CA_CERTS …` (set per
// user session). Windows uses `setx …` (per-user persistent env).
//
// Linux has no equivalent single-line command — env vars live in shell rc
// files the user controls. We write a guarded NODE_EXTRA_CA_CERTS export to
// ~/.profile (login shells), ~/.bashrc (bash interactive), and ~/.zshrc (zsh
// interactive). Block is wrapped in BEGIN/END markers so we can idempotently
// update + remove without touching anything else the user has written.
//
// Effective after: any new shell session OR `source ~/.profile`. We surface
// this clearly in the MITM start log so users know to relaunch their IDE.

const fs = require("fs");
const path = require("path");
const os = require("os");
const { log } = require("./logger");

const BLOCK_START = "# >>> krouter NODE_EXTRA_CA_CERTS >>>";
const BLOCK_END = "# <<< krouter NODE_EXTRA_CA_CERTS <<<";

const SHELL_RC_FILES = [
  ".profile",        // POSIX login shell (covers DEs that spawn Electron from .profile env)
  ".bash_profile",   // bash login shell on some distros
  ".bashrc",         // bash interactive — covers terminal-launched Antigravity
  ".zshrc",          // zsh interactive
];

function buildBlock(certPath) {
  return `${BLOCK_START}
# Auto-managed by kRouter — DO NOT EDIT. Set/unset via the kRouter MITM panel.
# Tells Node.js + Electron apps to trust the kRouter MITM root CA.
export NODE_EXTRA_CA_CERTS="${certPath}"
${BLOCK_END}`;
}

// Remove any existing kRouter block from the file contents, preserving everything else.
function stripBlock(contents) {
  if (!contents.includes(BLOCK_START)) return { contents, changed: false };
  // Multiline, lazy-match between markers. Capture preceding newline so we don't
  // leave a blank line behind when the block was the last thing in the file.
  const re = new RegExp(`\\n?${escapeRe(BLOCK_START)}[\\s\\S]*?${escapeRe(BLOCK_END)}\\n?`, "g");
  const next = contents.replace(re, "");
  return { contents: next, changed: next !== contents };
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

/**
 * Write NODE_EXTRA_CA_CERTS=<certPath> into the user's shell rc files.
 * Idempotent — re-running with the same path is a no-op; running with a new
 * path replaces the previous block in place.
 *
 * Returns the list of files that were created OR modified, for logging.
 */
function setLinuxNodeExtraCaCerts(certPath) {
  if (process.platform !== "linux") return [];
  if (!certPath || typeof certPath !== "string") return [];

  const home = os.homedir();
  const newBlock = buildBlock(certPath);
  const written = [];

  for (const file of SHELL_RC_FILES) {
    const filePath = path.join(home, file);
    try {
      const existed = fs.existsSync(filePath);
      const current = existed ? fs.readFileSync(filePath, "utf8") : "";

      // Strip any prior kRouter block, then append the new one.
      const { contents: cleaned } = stripBlock(current);

      // Skip rc files that don't exist UNLESS this is .profile — that one we
      // create from scratch so login-shell-launched DEs pick up the env var.
      if (!existed && file !== ".profile") continue;

      const sep = cleaned.length > 0 && !cleaned.endsWith("\n") ? "\n\n" : (cleaned.endsWith("\n\n") ? "" : "\n");
      const next = `${cleaned}${sep}${newBlock}\n`;

      // No-op short-circuit: if the cleaned + new block equals current, nothing to write
      if (next === current) continue;

      fs.writeFileSync(filePath, next, "utf8");
      written.push(filePath);
    } catch (e) {
      log(`[linux-node-ca] Could not write ${file}: ${e.message}`);
    }
  }

  return written;
}

/**
 * Remove the kRouter NODE_EXTRA_CA_CERTS block from all shell rc files.
 * Returns the list of files we touched.
 */
function unsetLinuxNodeExtraCaCerts() {
  if (process.platform !== "linux") return [];

  const home = os.homedir();
  const removed = [];

  for (const file of SHELL_RC_FILES) {
    const filePath = path.join(home, file);
    if (!fs.existsSync(filePath)) continue;
    try {
      const current = fs.readFileSync(filePath, "utf8");
      const { contents: stripped, changed } = stripBlock(current);
      if (!changed) continue;
      fs.writeFileSync(filePath, stripped, "utf8");
      removed.push(filePath);
    } catch (e) {
      log(`[linux-node-ca] Could not strip ${file}: ${e.message}`);
    }
  }

  return removed;
}

module.exports = { setLinuxNodeExtraCaCerts, unsetLinuxNodeExtraCaCerts };
