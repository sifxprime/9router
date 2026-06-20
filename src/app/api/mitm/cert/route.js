import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import os from "os";
import {
  trustCert,
  getCachedPassword,
  setCachedPassword,
  loadEncryptedPassword,
  isSudoPasswordRequired,
  initDbHooks,
} from "@/mitm/manager";
import { MITM_DIR } from "@/mitm/paths";
import { checkCertInstalled, uninstallCert } from "@/mitm/cert/install";
import { getSettings, updateSettings } from "@/lib/localDb";

initDbHooks(getSettings, updateSettings);

export const dynamic = "force-dynamic";

const IS_WIN = process.platform === "win32";
const KROUTER_CERT_PATH = path.join(MITM_DIR, "rootCA.crt");
// Legacy pre-rebrand cert path. If the user came from an old 9router install
// AND never ran kRouter ≥0.5.7, this file may still exist on disk even though
// the OS trust store entry shares the same CN as ours.
const LEGACY_CERT_PATH = path.join(
  IS_WIN
    ? path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "9router", "mitm")
    : path.join(os.homedir(), ".9router", "mitm"),
  "rootCA.crt"
);

function getPassword(provided) {
  return provided || getCachedPassword() || null;
}

async function resolvePassword(provided) {
  return provided || getCachedPassword() || await loadEncryptedPassword() || null;
}

// GET /api/mitm/cert — Inspect cert state
export async function GET() {
  try {
    const krouterCertExists = fs.existsSync(KROUTER_CERT_PATH);
    const legacyCertExists = fs.existsSync(LEGACY_CERT_PATH);

    let krouterTrusted = false;
    if (krouterCertExists) {
      try { krouterTrusted = await checkCertInstalled(KROUTER_CERT_PATH); } catch { /* unknown */ }
    }

    const hasCachedPassword = !!getCachedPassword() || !!(await loadEncryptedPassword());

    return NextResponse.json({
      krouter: {
        certFileExists: krouterCertExists,
        trusted: krouterTrusted,
        path: KROUTER_CERT_PATH,
      },
      legacy: {
        certFileExists: legacyCertExists,
        path: LEGACY_CERT_PATH,
      },
      hasCachedPassword,
      needsSudoPassword: !IS_WIN && !hasCachedPassword && isSudoPasswordRequired(),
      platform: process.platform,
    });
  } catch (error) {
    console.log("Error fetching cert status:", error);
    return NextResponse.json({ error: error.message || "Failed to fetch cert status" }, { status: 500 });
  }
}

// POST /api/mitm/cert — Install OR uninstall based on action
//   body: { action: "install" | "uninstall" | "cleanupLegacy", sudoPassword?: string }
export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const action = body?.action;
    if (!["install", "uninstall", "cleanupLegacy"].includes(action)) {
      return NextResponse.json({ error: "action must be install | uninstall | cleanupLegacy" }, { status: 400 });
    }

    const password = await resolvePassword(body?.sudoPassword);
    if (!IS_WIN && !password && isSudoPasswordRequired() && action !== "cleanupLegacy") {
      return NextResponse.json({ error: "Sudo password required", needsSudoPassword: true }, { status: 400 });
    }

    if (action === "install") {
      // trustCert auto-handles file generation guard + system trust + NSS DBs
      // and caches the sudo password on success so subsequent calls are quiet.
      await trustCert(password);
      return NextResponse.json({ success: true, action, certPath: KROUTER_CERT_PATH });
    }

    if (action === "uninstall") {
      if (!fs.existsSync(KROUTER_CERT_PATH)) {
        return NextResponse.json({ success: true, action, note: "No kRouter cert file to uninstall" });
      }
      await uninstallCert(password, KROUTER_CERT_PATH);
      if (password) setCachedPassword(password);
      return NextResponse.json({ success: true, action });
    }

    if (action === "cleanupLegacy") {
      // Best-effort: remove the on-disk legacy ~/.9router/mitm/rootCA.crt file.
      // Trust-store cleanup for the legacy CN happens automatically as part of
      // installCert / uninstallCert because we kept the CN unchanged. So just
      // unlinking the stale file is enough to leave a clean state.
      if (!fs.existsSync(LEGACY_CERT_PATH)) {
        return NextResponse.json({ success: true, action, note: "No legacy cert file found" });
      }
      try { fs.unlinkSync(LEGACY_CERT_PATH); }
      catch (e) { return NextResponse.json({ error: `Failed to remove legacy cert file: ${e.message}` }, { status: 500 }); }
      return NextResponse.json({ success: true, action });
    }

    return NextResponse.json({ error: "unreachable" }, { status: 500 });
  } catch (error) {
    console.log("Error in cert action:", error);
    return NextResponse.json({ error: error.message || "Cert action failed" }, { status: 500 });
  }
}
