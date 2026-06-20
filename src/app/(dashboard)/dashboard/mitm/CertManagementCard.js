"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, Button, Input } from "@/shared/components";

/**
 * Cert install / uninstall card for the MITM dashboard page.
 *
 * Behaviour:
 *   - Polls /api/mitm/cert on mount + after every action so the badges stay accurate.
 *   - Three buttons:
 *       Install/Reinstall → POST { action: "install" }   (with sudo password on mac/linux)
 *       Uninstall         → POST { action: "uninstall" }
 *       Cleanup Legacy    → POST { action: "cleanupLegacy" }  (only when ~/.9router/mitm/rootCA.crt exists)
 *   - Sudo password prompt appears only when needsSudoPassword === true AND not Windows.
 *   - Status badges:
 *       green check  → kRouter cert file exists + trusted in system store
 *       amber dot    → cert file exists but not trusted (install required)
 *       grey dash    → no cert file yet (server must be started once to generate it)
 *       red warn     → legacy 9router cert file lingering on disk (offers cleanup)
 */
export default function CertManagementCard() {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(null); // "install" | "uninstall" | "cleanupLegacy"
  const [sudoPassword, setSudoPassword] = useState("");
  const [message, setMessage] = useState(null); // { type: "success"|"error", text }

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/mitm/cert");
      const data = await res.json();
      if (res.ok) setStatus(data);
      else setMessage({ type: "error", text: data.error || "Failed to fetch cert status" });
    } catch (e) {
      setMessage({ type: "error", text: e.message });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchStatus(); }, [fetchStatus]);

  const runAction = async (action) => {
    setBusy(action);
    setMessage(null);
    try {
      const res = await fetch("/api/mitm/cert", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, sudoPassword: sudoPassword || undefined }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMessage({ type: "error", text: data.error || `Failed to ${action}` });
      } else {
        const labels = {
          install: "kRouter certificate installed",
          uninstall: "kRouter certificate uninstalled",
          cleanupLegacy: "Legacy 9router certificate file removed",
        };
        setMessage({ type: "success", text: data.note || labels[action] });
        setSudoPassword("");
      }
    } catch (e) {
      setMessage({ type: "error", text: e.message });
    } finally {
      setBusy(null);
      fetchStatus();
    }
  };

  if (loading) {
    return (
      <Card padding="md">
        <div className="text-sm text-text-muted">Loading certificate status…</div>
      </Card>
    );
  }

  if (!status) {
    return (
      <Card padding="md">
        <div className="text-sm text-red-500">Could not load certificate status.</div>
      </Card>
    );
  }

  const { krouter, legacy, needsSudoPassword, platform } = status;
  const isWin = platform === "win32";

  // Decide which primary action to show:
  //   - Cert file missing → must start the MITM server first (so it auto-generates the CA)
  //   - Cert file exists + trusted → "Reinstall" (replaces / refreshes)
  //   - Cert file exists + not trusted → "Install"
  const installLabel = krouter.trusted ? "Reinstall Certificate" : "Install Certificate";
  const showInstall = krouter.certFileExists;
  const showUninstall = krouter.certFileExists; // safe to remove even if not currently trusted
  const showCleanupLegacy = legacy.certFileExists;
  const showSudoInput = !isWin && needsSudoPassword && (busy === "install" || busy === "uninstall");

  // Badge logic
  let mainBadge;
  if (!krouter.certFileExists) {
    mainBadge = { color: "text-text-muted", icon: "remove", text: "Not generated yet" };
  } else if (krouter.trusted) {
    mainBadge = { color: "text-green-500", icon: "check_circle", text: "Trusted by system" };
  } else {
    mainBadge = { color: "text-amber-500", icon: "info", text: "Cert file present, not in system trust store" };
  }

  return (
    <Card padding="md">
      <div className="flex flex-col gap-3">
        {/* Header row */}
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="font-medium text-sm">MITM Root Certificate</h3>
            <p className="text-xs text-text-muted mt-0.5 leading-relaxed">
              Installs the kRouter root CA into the OS trust store so IDE apps (Antigravity, Kiro, Claude Desktop)
              trust kRouter&apos;s self-signed certificate for HTTPS interception.
            </p>
          </div>
          <span className={`material-symbols-outlined text-[20px] shrink-0 ${mainBadge.color}`}>{mainBadge.icon}</span>
        </div>

        {/* Status grid */}
        <div className="grid grid-cols-1 sm:grid-cols-[8rem_auto_1fr] gap-1 sm:gap-2 text-xs">
          <span className="text-text-muted">Status:</span>
          <span className={`hidden sm:inline ${mainBadge.color}`}>→</span>
          <span className={mainBadge.color}>{mainBadge.text}</span>

          <span className="text-text-muted">Cert file:</span>
          <span className="hidden sm:inline text-text-muted">→</span>
          <code className="font-mono text-[11px] text-text-main break-all">{krouter.path}</code>

          {legacy.certFileExists && (
            <>
              <span className="text-amber-600">Legacy:</span>
              <span className="hidden sm:inline text-amber-600">→</span>
              <code className="font-mono text-[11px] text-amber-600 break-all">{legacy.path} (orphaned)</code>
            </>
          )}
        </div>

        {/* Sudo password input (Mac/Linux only) */}
        {showSudoInput && (
          <div className="rounded border border-border bg-surface/30 p-2.5 space-y-1.5">
            <label className="text-xs text-text-main">Sudo password needed for system trust store</label>
            <Input
              type="password"
              autoFocus
              value={sudoPassword}
              onChange={(e) => setSudoPassword(e.target.value)}
              placeholder="Your macOS / Linux account password"
              className="text-sm"
            />
            <p className="text-[11px] text-text-muted">
              Used once to write to the system keychain, then cached encrypted at <code>~/.krouter/mitm/sudo</code>.
              Not sent anywhere.
            </p>
          </div>
        )}

        {/* Action buttons */}
        <div className="flex flex-wrap gap-2">
          {showInstall && (
            <Button
              variant="primary"
              size="sm"
              onClick={() => runAction("install")}
              loading={busy === "install"}
              disabled={!!busy}
            >
              {installLabel}
            </Button>
          )}
          {showUninstall && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => runAction("uninstall")}
              loading={busy === "uninstall"}
              disabled={!!busy}
            >
              Uninstall
            </Button>
          )}
          {showCleanupLegacy && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => runAction("cleanupLegacy")}
              loading={busy === "cleanupLegacy"}
              disabled={!!busy}
            >
              Remove Legacy 9router Cert
            </Button>
          )}
          {!showInstall && !showUninstall && (
            <p className="text-xs text-text-muted">
              Start the MITM Server above once — it will generate the root CA, then this card will let you install it.
            </p>
          )}
        </div>

        {/* Status message */}
        {message && (
          <div className={`rounded border p-2 text-xs ${
            message.type === "success"
              ? "border-green-500/30 bg-green-500/10 text-green-600 dark:text-green-400"
              : "border-red-500/30 bg-red-500/10 text-red-500"
          }`}>
            {message.text}
          </div>
        )}
      </div>
    </Card>
  );
}
