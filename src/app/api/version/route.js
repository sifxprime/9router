import { NextResponse } from "next/server";
import https from "https";
import cliPkg from "../../../../cli/package.json" with { type: "json" };

// Brand: this fork publishes under @sifxprime/krouter on npm. The dashboard's
// "Update now" banner polls this package's "latest" tag and compares against
// the installed version. The CLI also does its own check at startup (see
// cli/cli.js:checkForUpdate). Both use the same registry endpoint.
// IMPORTANT: we import cli/package.json — the root package.json is "krouter-app"
// (the unpublished Next.js dashboard); the published CLI npm package is
// @sifxprime/krouter and that is what existing users actually run.
const PACKAGE_NAME = cliPkg.name;
const CURRENT_VERSION = cliPkg.version;
const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
const FETCH_TIMEOUT_MS = 4000;

export const dynamic = "force-dynamic";

// Compare semver "a.b.c" — returns 1 if a > b, -1 if a < b, 0 if equal.
function compareVersions(a, b) {
  const pa = String(a || "0.0.0").split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b || "0.0.0").split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

function fetchLatestVersion() {
  return new Promise((resolve) => {
    const req = https.get(REGISTRY_URL, { timeout: FETCH_TIMEOUT_MS }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed?.version || null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
  });
}

export async function GET() {
  const latestVersion = await fetchLatestVersion();
  const hasUpdate = latestVersion ? compareVersions(latestVersion, CURRENT_VERSION) === 1 : false;

  return NextResponse.json({
    currentVersion: CURRENT_VERSION,
    latestVersion: latestVersion || CURRENT_VERSION,
    hasUpdate,
    packageName: PACKAGE_NAME,
  }, { headers: { "Cache-Control": "no-store" } });
}
