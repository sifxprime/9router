"use server";

import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { exec } from "child_process";
import { promisify } from "util";
import { parseTOML, stringifyTOML } from "confbox";

const execAsync = promisify(exec);

const getJcodeConfigDir = () => path.join(os.homedir(), ".jcode");
const getConfigPath = () => path.join(getJcodeConfigDir(), "config.toml");

// Provider names and on-disk artifacts. "krouter" is canonical; "9router" is read
// for backward-compat with existing jcode installs from before the rename.
const PROVIDER_KEY = "krouter";
const LEGACY_PROVIDER_KEY = "9router";
const ENV_FILE = "provider-krouter.env";
const LEGACY_ENV_FILE = "provider-9router.env";
const API_KEY_ENV_VAR = "JCODE_KROUTER_API_KEY";
const LEGACY_API_KEY_ENV_VAR = "JCODE_9ROUTER_API_KEY";

const getProviderEnvPath = () => {
  const configDir = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(configDir, "jcode", ENV_FILE);
};
const getLegacyProviderEnvPath = () => {
  const configDir = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(configDir, "jcode", LEGACY_ENV_FILE);
};

const checkJcodeInstalled = async () => {
  try {
    const isWindows = os.platform() === "win32";
    const command = isWindows ? "where jcode" : "which jcode";
    await execAsync(command, { windowsHide: true });
    return true;
  } catch {
    try {
      await fs.access(getJcodeConfigDir());
      return true;
    } catch {
      return false;
    }
  }
};

const readConfig = async () => {
  try {
    const configPath = getConfigPath();
    const content = await fs.readFile(configPath, "utf-8");
    return parseTOML(content);
  } catch (error) {
    return { providers: {} };
  }
};

const hasKRouterConfig = (config) => {
  if (!config || !config.providers) return false;

  const providers = config.providers;

  if (providers[PROVIDER_KEY] || providers[LEGACY_PROVIDER_KEY]) return true;

  for (const [name, provider] of Object.entries(providers)) {
    if (provider.base_url && provider.base_url.includes("localhost:20128")) {
      return true;
    }
  }

  return false;
};

const writeConfig = async (config) => {
  const configPath = getConfigPath();
  const content = stringifyTOML(config);
  await fs.writeFile(configPath, content, "utf-8");
};

const readProviderEnv = async () => {
  // Read the new provider-krouter.env first; fall back to legacy file for existing installs.
  let envPath = getProviderEnvPath();
  try {
    await fs.access(envPath);
  } catch {
    envPath = getLegacyProviderEnvPath();
  }
  try {
    const content = await fs.readFile(envPath, "utf-8");
    const env = {};

    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;

      const eqIndex = trimmed.indexOf("=");
      if (eqIndex > 0) {
        const key = trimmed.slice(0, eqIndex).trim();
        let value = trimmed.slice(eqIndex + 1).trim();

        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }

        env[key] = value;
      }
    }

    return env;
  } catch {
    return {};
  }
};

const writeProviderEnv = async (env) => {
  const envPath = getProviderEnvPath();
  let content = "# jcode provider environment variables\n";

  for (const [key, value] of Object.entries(env)) {
    content += `${key}="${value}"\n`;
  }

  await fs.writeFile(envPath, content, "utf-8");
};

export async function GET() {
  const isInstalled = await checkJcodeInstalled();

  if (!isInstalled) {
    return NextResponse.json({
      installed: false,
      message: "jcode not installed. Install via: curl -fsSL https://raw.githubusercontent.com/1jehuang/jcode/master/scripts/install.sh | bash",
    });
  }

  const config = await readConfig();
  const hasKRouter = hasKRouterConfig(config);

  return NextResponse.json({
    installed: true,
    config,
    hasKRouter,
    has9Router: hasKRouter, // legacy field name kept for UIs not yet updated
    configPath: getConfigPath(),
  });
}

export async function POST(request) {
  try {
    const { baseUrl, apiKey, models } = await request.json();

    if (!baseUrl || !apiKey) {
      return NextResponse.json(
        { error: "baseUrl and apiKey are required" },
        { status: 400 }
      );
    }

    const normalizedBaseUrl = baseUrl.endsWith("/v1")
      ? baseUrl
      : `${baseUrl}/v1`;

    let config = await readConfig();

    if (!config.providers) {
      config.providers = {};
    }

    config.providers[PROVIDER_KEY] = {
      type: "openai-compatible",
      base_url: normalizedBaseUrl,
      auth: "bearer",
      api_key_env: API_KEY_ENV_VAR,
      env_file: ENV_FILE,
      default_model: models && models.length > 0 ? models[0] : "cc/claude-opus-4-7",
      requires_api_key: true,
    };
    // Remove the legacy provider block on this write so the user's config ends up canonical
    delete config.providers[LEGACY_PROVIDER_KEY];

    const configDir = getJcodeConfigDir();
    await fs.mkdir(configDir, { recursive: true });

    await writeConfig(config);

    const xdgConfigDir = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
    const jcodeConfigDir = path.join(xdgConfigDir, "jcode");
    await fs.mkdir(jcodeConfigDir, { recursive: true });

    const env = await readProviderEnv();
    env[API_KEY_ENV_VAR] = apiKey;
    delete env[LEGACY_API_KEY_ENV_VAR];
    await writeProviderEnv(env);
    // Best-effort remove legacy env file so it doesn't shadow the new one
    try { await fs.unlink(getLegacyProviderEnvPath()); } catch { /* not present */ }

    return NextResponse.json({
      success: true,
      message: "jcode configured successfully. Use: jcode --provider-profile krouter",
      configPath: getConfigPath(),
    });
  } catch (error) {
    console.error("Error configuring jcode:", error);
    return NextResponse.json(
      { error: error.message },
      { status: 500 }
    );
  }
}

export async function DELETE() {
  try {
    const config = await readConfig();

    if (!config.providers) {
      return NextResponse.json({ success: true, message: "No configuration to remove" });
    }

    delete config.providers[PROVIDER_KEY];
    delete config.providers[LEGACY_PROVIDER_KEY];

    await writeConfig(config);

    const env = await readProviderEnv();
    delete env[API_KEY_ENV_VAR];
    delete env[LEGACY_API_KEY_ENV_VAR];
    await writeProviderEnv(env);
    try { await fs.unlink(getLegacyProviderEnvPath()); } catch { /* not present */ }

    return NextResponse.json({
      success: true,
      message: "kRouter configuration removed from jcode",
    });
  } catch (error) {
    console.error("Error removing jcode configuration:", error);
    return NextResponse.json(
      { error: error.message },
      { status: 500 }
    );
  }
}
