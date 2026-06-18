const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync } = require("child_process");

const APP_NAME = "krouter";
const LEGACY_APP_NAME = "9router";
const APP_LABEL = "com.krouter.autostart";
const LEGACY_APP_LABEL = "com.9router.autostart";

/**
 * Resolve the absolute path to this package's cli.js.
 *
 * Order of preference:
 *   1. Explicit `cliPath` argument — cleanest, used when called from running
 *      cli.js with `__filename`.
 *   2. `process.argv[1]` if it's our cli.js — true when 9router is currently
 *      running and the tray menu fires this code path.
 *   3. Compute relative to this file's own location. autostart.js lives at
 *      `<pkg>/src/cli/tray/autostart.js`, so cli.js is three levels up.
 *      This works for any global install layout (nvm, Volta, asdf, Homebrew,
 *      /usr/local, etc.) without depending on `npm bin -g` (removed in npm 9)
 *      or a hardcoded `/usr/local/...` path.
 *
 * Returns null if no candidate exists — callers should not write an autostart
 * entry pointing at a non-existent script.
 */
function getCliJsPath(cliPath) {
  if (cliPath) {
    const resolved = path.resolve(cliPath);
    if (fs.existsSync(resolved)) return resolved;
  }
  if (process.argv[1]) {
    const resolved = path.resolve(process.argv[1]);
    if (path.basename(resolved) === "cli.js" && fs.existsSync(resolved)) {
      return resolved;
    }
  }
  const computed = path.resolve(__dirname, "..", "..", "..", "cli.js");
  if (fs.existsSync(computed)) return computed;
  return null;
}

/**
 * Enable auto startup on OS boot
 * @param {string} cliPath - Optional path to cli.js (defaults to auto-detect)
 * @returns {boolean} success
 */
function enableAutoStart(cliPath) {
  const platform = process.platform;

  if (!["darwin", "win32", "linux"].includes(platform)) return false;
  if (platform === "linux" && !process.env.DISPLAY) return false;

  try {
    if (platform === "darwin") return enableMacOS(cliPath);
    if (platform === "win32") return enableWindows(cliPath);
    if (platform === "linux") return enableLinux(cliPath);
  } catch (err) {
    // Silent fail — autostart is optional
  }
  return false;
}

/**
 * Disable auto startup
 * @returns {boolean} success
 */
function disableAutoStart() {
  const platform = process.platform;
  try {
    if (platform === "darwin") return disableMacOS();
    if (platform === "win32") return disableWindows();
    if (platform === "linux") return disableLinux();
  } catch (err) {}
  return false;
}

/**
 * Check if autostart is enabled.
 *
 * On macOS, both the plist file and the launchd registration must be present —
 * otherwise the tray menu would lie about the state (showing "✓ Enabled" even
 * when launchd has the agent in a failed state or hasn't loaded it).
 *
 * Both the new label (com.krouter.autostart) and the legacy label
 * (com.9router.autostart) count as enabled, so a pre-rename install still
 * reads as enabled until the next enable/disable cleans up the legacy plist.
 */
function isAutoStartEnabled() {
  const platform = process.platform;

  try {
    if (platform === "darwin") {
      const newPlist = path.join(os.homedir(), "Library", "LaunchAgents", `${APP_LABEL}.plist`);
      const legacyPlist = path.join(os.homedir(), "Library", "LaunchAgents", `${LEGACY_APP_LABEL}.plist`);
      const checkLabel = (label) => {
        try {
          execSync(`launchctl list ${label}`, {
            stdio: ["ignore", "ignore", "ignore"],
            timeout: 3000
          });
          return true;
        } catch { return false; }
      };
      if (fs.existsSync(newPlist) && checkLabel(APP_LABEL)) return true;
      if (fs.existsSync(legacyPlist) && checkLabel(LEGACY_APP_LABEL)) return true;
      return false;
    } else if (platform === "win32") {
      const startupDir = path.join(process.env.APPDATA || "", "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
      return fs.existsSync(path.join(startupDir, `${APP_NAME}.vbs`))
        || fs.existsSync(path.join(startupDir, `${LEGACY_APP_NAME}.vbs`));
    } else if (platform === "linux") {
      const autostartDir = path.join(os.homedir(), ".config", "autostart");
      return fs.existsSync(path.join(autostartDir, `${APP_NAME}.desktop`))
        || fs.existsSync(path.join(autostartDir, `${LEGACY_APP_NAME}.desktop`));
    }
  } catch (e) {}
  return false;
}

// ============ macOS ============

/**
 * Returns true when the current Node process IS the running instance that
 * launchd is managing under our agent label.
 *
 * `launchctl unload <plist>` (and `load`) for an Aqua user-domain agent sends
 * SIGTERM to the running process. When the running 9router cli.js was itself
 * spawned by the autostart launchd agent (i.e. user enabled autostart at
 * some point, then rebooted, then clicked the tray icon's "Disable
 * Auto-start" menu item), an unload would kill the very process executing
 * the click handler — and the tray icon would disappear instead of the menu
 * label flipping back to "Enable Auto-start". This helper lets the enable
 * and disable paths sidestep that by skipping launchctl when we'd otherwise
 * be killing ourselves.
 */
function isAgentSelfMacOS(label = APP_LABEL) {
  try {
    const output = execSync(`launchctl list ${label}`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000
    });
    const match = output.match(/"PID"\s*=\s*(\d+)/);
    return !!(match && parseInt(match[1], 10) === process.pid);
  } catch (e) {
    return false;
  }
}

/**
 * One-time migration: remove the legacy `com.9router.autostart` LaunchAgent so
 * upgrading installs don't end up with TWO kRouter processes firing on every
 * login (legacy + new agent both registered with launchd).
 *
 * Self-kill protection: if the current process IS the running legacy agent
 * (i.e. user enabled autostart under the old version, then rebooted, then
 * upgraded and clicked "Enable autostart" again), unloading the legacy plist
 * would SIGTERM us mid-execution. Skip the unload in that case — just delete
 * the plist file. launchd will release the agent on next login or quit, and
 * the new agent we're about to write takes over from then on.
 */
function cleanupLegacyMacOSAutostart() {
  const legacyPlist = path.join(os.homedir(), "Library", "LaunchAgents", `${LEGACY_APP_LABEL}.plist`);
  if (!fs.existsSync(legacyPlist)) return;

  if (!isAgentSelfMacOS(LEGACY_APP_LABEL)) {
    try {
      execSync(`launchctl unload "${legacyPlist}"`, { stdio: "ignore" });
    } catch (e) { /* best effort — the file removal below is what actually matters */ }
  }
  try {
    fs.unlinkSync(legacyPlist);
  } catch (e) { /* leave it alone if we can't write */ }
}

/**
 * One-time best-effort sweep run at every kRouter startup: detect autostart
 * entries (LaunchAgent / Startup .vbs / .desktop) that point at an executable
 * which no longer exists on disk, and remove them. Catches the upgrade case
 * where a v0.5.6 user:
 *   1. had autostart enabled (entry points at npm-global path of the old
 *      `9router` package)
 *   2. ran `npm uninstall -g 9router` then `npm i -g @sifxprime/krouter`
 *   3. the entry now references a binary that no longer exists, so launchd
 *      logs an error every boot and no tray appears.
 *
 * After cleanup the user can re-enable autostart from the new tray menu and
 * the cleanup helpers above write a fresh entry pointing at the new install.
 */
function sweepDanglingAutostartEntries() {
  if (process.platform === "darwin") {
    for (const label of [LEGACY_APP_LABEL, APP_LABEL]) {
      const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`);
      if (!fs.existsSync(plistPath)) continue;
      try {
        const content = fs.readFileSync(plistPath, "utf-8");
        // ProgramArguments are inside <string>…</string> tags; we care about the
        // FIRST node executable and the SECOND argument (path to cli.js).
        const argMatches = [...content.matchAll(/<string>([^<]+)<\/string>/g)].map((m) => m[1]);
        // Find the path that looks like a cli.js entry (ends with cli.js or
        // is the npm-global lib path for the old "9router" package).
        const scriptArg = argMatches.find((a) => /cli\.js$/.test(a) || a.includes("9router"));
        if (scriptArg && !fs.existsSync(scriptArg)) {
          if (!isAgentSelfMacOS(label)) {
            try { execSync(`launchctl unload "${plistPath}"`, { stdio: "ignore" }); } catch { /* ignore */ }
          }
          fs.unlinkSync(plistPath);
        }
      } catch { /* unreadable plist — skip */ }
    }
  } else if (process.platform === "win32") {
    const startupDir = path.join(process.env.APPDATA || "", "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
    for (const name of [`${APP_NAME}.vbs`, `${LEGACY_APP_NAME}.vbs`]) {
      const vbsPath = path.join(startupDir, name);
      if (!fs.existsSync(vbsPath)) continue;
      try {
        const content = fs.readFileSync(vbsPath, "utf-8");
        // VBS shape: WshShell.Run """{nodePath}"" ""{cliJsPath}"" --tray --skip-update", 0, False
        const m = content.match(/WshShell\.Run\s+"""([^"]+)""\s+""([^"]+)""/);
        if (m && (!fs.existsSync(m[1]) || !fs.existsSync(m[2]))) {
          fs.unlinkSync(vbsPath);
        }
      } catch { /* unreadable vbs — skip */ }
    }
  } else if (process.platform === "linux") {
    const autostartDir = path.join(os.homedir(), ".config", "autostart");
    for (const name of [`${APP_NAME}.desktop`, `${LEGACY_APP_NAME}.desktop`]) {
      const desktopPath = path.join(autostartDir, name);
      if (!fs.existsSync(desktopPath)) continue;
      try {
        const content = fs.readFileSync(desktopPath, "utf-8");
        const m = content.match(/^Exec=(\S+)\s+(\S+)/m);
        if (m && (!fs.existsSync(m[1]) || !fs.existsSync(m[2]))) {
          fs.unlinkSync(desktopPath);
        }
      } catch { /* unreadable desktop — skip */ }
    }
  }
}

function enableMacOS(cliPath) {
  // Migrate away from the pre-rename plist BEFORE writing the new one so the
  // user doesn't end up with two LaunchAgents both firing on next login.
  cleanupLegacyMacOSAutostart();

  const launchAgentsDir = path.join(os.homedir(), "Library", "LaunchAgents");
  const plistPath = path.join(launchAgentsDir, `${APP_LABEL}.plist`);

  if (!fs.existsSync(launchAgentsDir)) {
    fs.mkdirSync(launchAgentsDir, { recursive: true });
  }

  const nodePath = process.execPath;
  const routerScript = getCliJsPath(cliPath);
  // Don't write a broken plist that references a non-existent script.
  if (!routerScript) return false;

  // Invoke node + cli.js directly with absolute paths — no shell wrapper.
  // The previous design ran `zsh -l -c "..."` so a login shell would source
  // nvm/.zshrc and set PATH; that's fragile (nvm.sh sourcing varies by user,
  // some setups don't put node on PATH from a non-interactive login shell).
  // EnvironmentVariables.PATH explicitly includes node's bin dir so child
  // processes spawned by cli.js (npm install at runtime, etc.) resolve.
  const launchPath = `${path.dirname(nodePath)}:/usr/local/bin:/usr/bin:/bin`;

  const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${APP_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${nodePath}</string>
        <string>${routerScript}</string>
        <string>--tray</string>
        <string>--skip-update</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${launchPath}</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <false/>
    <key>StandardOutPath</key>
    <string>/tmp/krouter.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/krouter.error.log</string>
</dict>
</plist>`;

  fs.writeFileSync(plistPath, plistContent);

  // If we're the running agent already, launchctl unload/load would send
  // ourselves SIGTERM. Skip it — the plist file is updated on disk and
  // launchd will pick it up at next login. isAutoStartEnabled() will still
  // return true because launchctl already has the agent loaded.
  if (isAgentSelfMacOS()) {
    return true;
  }

  // Register with launchd in the current session. Without this, the agent
  // only takes effect on the next user login and the user has no signal that
  // anything actually happened. `unload` first defends against re-enable
  // replacing an existing plist.
  try {
    execSync(`launchctl unload "${plistPath}"`, { stdio: "ignore" });
  } catch (e) {}
  try {
    execSync(`launchctl load -w "${plistPath}"`, { stdio: "ignore" });
  } catch (e) {
    // Even if load fails, the plist is on disk and will be picked up at next
    // login; report success based on the file write.
  }
  return true;
}

function disableMacOS() {
  // Also clear any legacy plist still on disk — see cleanupLegacyMacOSAutostart.
  cleanupLegacyMacOSAutostart();

  const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${APP_LABEL}.plist`);

  // Don't kill ourselves: when the current process is the running agent,
  // `launchctl unload` would send SIGTERM and the user clicking
  // "Disable Auto-start" from the tray menu would lose their tray icon
  // instead of just flipping the menu label. Skip the unload — removing the
  // plist file is enough to prevent the agent from starting on next login.
  if (!isAgentSelfMacOS()) {
    try {
      execSync(`launchctl unload "${plistPath}"`, { stdio: "ignore" });
    } catch (e) {}
  }

  if (fs.existsSync(plistPath)) {
    fs.unlinkSync(plistPath);
  }
  return true;
}

// ============ Windows ============

function enableWindows(cliPath) {
  const startupDir = path.join(process.env.APPDATA || "", "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
  const vbsPath = path.join(startupDir, `${APP_NAME}.vbs`);
  const legacyVbsPath = path.join(startupDir, `${LEGACY_APP_NAME}.vbs`);

  if (!fs.existsSync(startupDir)) return false;

  // Migrate away from the pre-rename startup entry so we don't double-launch.
  if (fs.existsSync(legacyVbsPath)) {
    try { fs.unlinkSync(legacyVbsPath); } catch { /* best effort */ }
  }

  const nodePath = process.execPath;
  const routerScript = getCliJsPath(cliPath);
  if (!routerScript) return false;

  // Run node + cli.js directly, hidden window. Avoids the fragile
  // `9router.cmd` lookup that depended on the npm prefix path.
  const vbsContent = `Set WshShell = CreateObject("WScript.Shell")
WshShell.Run """${nodePath}"" ""${routerScript}"" --tray --skip-update", 0, False
`;
  fs.writeFileSync(vbsPath, vbsContent);
  return true;
}

function disableWindows() {
  const startupDir = path.join(process.env.APPDATA || "", "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
  for (const name of [`${APP_NAME}.vbs`, `${LEGACY_APP_NAME}.vbs`]) {
    const p = path.join(startupDir, name);
    if (fs.existsSync(p)) {
      try { fs.unlinkSync(p); } catch { /* best effort */ }
    }
  }
  return true;
}

// ============ Linux ============

function enableLinux(cliPath) {
  const autostartDir = path.join(os.homedir(), ".config", "autostart");
  const desktopPath = path.join(autostartDir, `${APP_NAME}.desktop`);
  const legacyDesktopPath = path.join(autostartDir, `${LEGACY_APP_NAME}.desktop`);

  if (!fs.existsSync(autostartDir)) {
    try { fs.mkdirSync(autostartDir, { recursive: true }); }
    catch (e) { return false; }
  }

  // Migrate away from the pre-rename autostart entry so we don't double-launch.
  if (fs.existsSync(legacyDesktopPath)) {
    try { fs.unlinkSync(legacyDesktopPath); } catch { /* best effort */ }
  }

  const nodePath = process.execPath;
  const routerScript = getCliJsPath(cliPath);
  if (!routerScript) return false;

  const desktopContent = `[Desktop Entry]
Type=Application
Name=kRouter
Comment=kRouter API Proxy
Exec=${nodePath} ${routerScript} --tray --skip-update
Hidden=false
NoDisplay=false
X-GNOME-Autostart-enabled=true
`;
  fs.writeFileSync(desktopPath, desktopContent);
  return true;
}

function disableLinux() {
  const autostartDir = path.join(os.homedir(), ".config", "autostart");
  for (const name of [`${APP_NAME}.desktop`, `${LEGACY_APP_NAME}.desktop`]) {
    const p = path.join(autostartDir, name);
    if (fs.existsSync(p)) {
      try { fs.unlinkSync(p); } catch { /* best effort */ }
    }
  }
  return true;
}

module.exports = {
  enableAutoStart,
  disableAutoStart,
  isAutoStartEnabled,
  sweepDanglingAutostartEntries
};
