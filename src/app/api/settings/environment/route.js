import { NextResponse } from "next/server";
import { ENV_VAR_CATALOG, CATEGORIES, isCataloguedEnvVar } from "@/shared/constants/envVars";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// Names we deliberately HIDE from the panel even if set. These leak into process.env
// from framework/OS internals and would just be noise.
const NEVER_SHOW = new Set([
  "PATH", "HOME", "USER", "SHELL", "LANG", "LC_ALL", "PWD", "TMPDIR", "DISPLAY",
  "XDG_CONFIG_HOME", "APPDATA", "LOCALAPPDATA", "TERM", "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION", "CODESPACES", "GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN",
  "NEXT_PHASE", "NEXT_RUNTIME", "NEXT_TELEMETRY_DISABLED",
  "__NEXT_PRIVATE_STANDALONE_CONFIG", "__NEXT_PRIVATE_PREBUNDLED_REACT",
  "S", "P", // single-letter junk vars
]);

// Heuristic — even uncatalogued vars that match these get redacted just in case.
const SECRET_HEURISTICS = /SECRET|TOKEN|PASSWORD|API_KEY|PRIVATE/;

function maskValue(value) {
  if (!value) return "";
  if (value.length <= 4) return "•".repeat(value.length);
  return value.slice(0, 2) + "•".repeat(Math.max(4, value.length - 4)) + value.slice(-2);
}

export async function GET() {
  try {
    const catalogued = ENV_VAR_CATALOG.map((entry) => {
      const raw = process.env[entry.name];
      const isSet = raw !== undefined && raw !== "";
      const displayValue = !isSet
        ? null
        : entry.secret
          ? maskValue(raw)
          : raw;
      return {
        name: entry.name,
        category: entry.category,
        desc: entry.desc,
        default: entry.default,
        secret: !!entry.secret,
        deprecated: !!entry.deprecated,
        isSet,
        value: displayValue,
      };
    });

    // Surface any KROUTER_*, NINE_ROUTER_*, MITM_*, OBSERVABILITY_*, OAUTH_*, UPDATER_*
    // var actually set in env that isn't in the catalog — so users see surprises.
    const PREFIXES = ["KROUTER_", "NINE_ROUTER_", "MITM_", "OBSERVABILITY_", "OAUTH_", "UPDATER_", "KIRO_", "KIMI_"];
    const uncatalogued = [];
    for (const name of Object.keys(process.env)) {
      if (NEVER_SHOW.has(name)) continue;
      if (isCataloguedEnvVar(name)) continue;
      const matchesPrefix = PREFIXES.some((p) => name.startsWith(p));
      if (!matchesPrefix) continue;
      const raw = process.env[name];
      const looksSecret = SECRET_HEURISTICS.test(name);
      uncatalogued.push({
        name,
        category: "other",
        desc: "Set in environment but not officially catalogued",
        default: "(unset by default)",
        secret: looksSecret,
        deprecated: false,
        isSet: true,
        value: looksSecret ? maskValue(raw) : raw,
      });
    }

    return NextResponse.json(
      {
        categories: CATEGORIES,
        vars: [...catalogued, ...uncatalogued.sort((a, b) => a.name.localeCompare(b.name))],
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    console.log("Error reading environment:", error);
    return NextResponse.json({ error: "Failed to read environment" }, { status: 500 });
  }
}
