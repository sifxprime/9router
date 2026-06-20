import { NextResponse } from "next/server";
import { createProviderConnection, getProviderConnections } from "@/lib/localDb";
import fs from "fs";
import path from "path";
import os from "os";

export const dynamic = "force-dynamic";

const CLI_PROXY_DIR = path.join(os.homedir(), ".cli-proxy-api");

const PROVIDER_MAP = {
  codex: "codex",
  openai: "codex",
  claude: "claude",
  anthropic: "claude",
};

function detectProvider(authJson, fileName) {
  if (authJson.provider) return PROVIDER_MAP[authJson.provider] || authJson.provider;
  const lower = fileName.toLowerCase();
  if (lower.includes("claude") || lower.includes("anthropic")) return "claude";
  if (lower.includes("codex") || lower.includes("openai")) return "codex";
  return "codex";
}

export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const sourceDir = body.sourceDir || CLI_PROXY_DIR;

    if (!fs.existsSync(sourceDir)) {
      return NextResponse.json(
        { error: `Directory not found: ${sourceDir}`, imported: 0 },
        { status: 404 }
      );
    }

    const files = fs.readdirSync(sourceDir).filter((f) => f.endsWith(".json"));
    if (files.length === 0) {
      return NextResponse.json({ error: "No JSON auth files found", imported: 0 }, { status: 404 });
    }

    const results = [];
    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(sourceDir, file), "utf-8");
        const authJson = JSON.parse(raw);
        const accessToken = authJson.accessToken || authJson.access_token;
        const refreshToken = authJson.refreshToken || authJson.refresh_token;
        if (!accessToken) {
          results.push({ file, status: "skipped", reason: "no accessToken" });
          continue;
        }

        const provider = detectProvider(authJson, file);
        const email = authJson.email || "";
        const connectionName = email || file.replace(/\.json$/, "");

        const existing = await getProviderConnections({ provider });
        const duplicate = existing.some(
          (c) => c.name === connectionName || c.apiKey === accessToken
        );
        if (duplicate) {
          results.push({ file, status: "skipped", reason: "duplicate" });
          continue;
        }

        await createProviderConnection({
          provider,
          name: connectionName,
          authType: "access_token",
          accessToken,
          refreshToken: refreshToken || null,
          email,
          isActive: true,
          providerSpecificData: {
            importedFrom: "cli-proxy-api",
            planType: authJson.plan_type || authJson.chatgpt_plan_type || "",
          },
        });
        results.push({ file, status: "imported", provider, name: connectionName });
      } catch (e) {
        results.push({ file, status: "error", reason: e.message });
      }
    }

    const imported = results.filter((r) => r.status === "imported").length;
    return NextResponse.json({ imported, total: files.length, results });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function GET() {
  const exists = fs.existsSync(CLI_PROXY_DIR);
  const files = exists
    ? fs.readdirSync(CLI_PROXY_DIR).filter((f) => f.endsWith(".json"))
    : [];
  return NextResponse.json({
    available: exists && files.length > 0,
    directory: CLI_PROXY_DIR,
    fileCount: files.length,
  });
}
