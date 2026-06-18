"use server";

import { NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import os from "os";

const execAsync = promisify(exec);

const getConfigDir = () => path.join(os.homedir(), ".config", "opencode");
const getConfigPath = () => path.join(getConfigDir(), "opencode.json");

// Check if opencode CLI is installed (via which/where or config file exists)
const checkOpenCodeInstalled = async () => {
  try {
    const isWindows = os.platform() === "win32";
    const command = isWindows ? "where opencode" : "which opencode";
    const env = isWindows
      ? { ...process.env, PATH: `${process.env.APPDATA}\\npm;${process.env.PATH}` }
      : process.env;
    await execAsync(command, { windowsHide: true, env });
    return true;
  } catch {
    try {
      await fs.access(getConfigPath());
      return true;
    } catch {
      return false;
    }
  }
};

const readConfig = async () => {
  try {
    const content = await fs.readFile(getConfigPath(), "utf-8");
    return JSON.parse(content);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
};

// Provider key in OpenCode's opencode.json. "krouter" is the canonical key; "9router"
// is read as a fallback for existing user configs from before the rename, and removed
// from the file the next time we write.
const PROVIDER_KEY = "krouter";
const LEGACY_PROVIDER_KEY = "9router";
const MODEL_PREFIX = "krouter/";
const MODEL_PREFIX_RE = /^(?:krouter|9router)\//;

const getProviderEntry = (config) => (
  config?.provider?.[PROVIDER_KEY] ?? config?.provider?.[LEGACY_PROVIDER_KEY] ?? null
);

const hasKRouterConfig = (config) => !!getProviderEntry(config);

// GET - Check opencode CLI and read current settings
export async function GET() {
  try {
    const isInstalled = await checkOpenCodeInstalled();

    if (!isInstalled) {
      return NextResponse.json({
        installed: false,
        config: null,
        message: "OpenCode CLI is not installed",
      });
    }

    const config = await readConfig();
    const providerConfig = getProviderEntry(config);
    const modelMap = providerConfig?.models || {};

    return NextResponse.json({
      installed: true,
      config,
      hasKRouter: hasKRouterConfig(config),
      has9Router: hasKRouterConfig(config), // legacy field name kept for any UI not yet updated
      configPath: getConfigPath(),
        opencode: {
          models: Object.keys(modelMap),
          activeModel: MODEL_PREFIX_RE.test(config?.model || "") ? config.model.replace(MODEL_PREFIX_RE, "") : null,
          baseURL: providerConfig?.options?.baseURL || null,
        },
    });
  } catch (error) {
    console.log("Error checking opencode settings:", error);
    return NextResponse.json({ error: "Failed to check opencode settings" }, { status: 500 });
  }
}

// POST - Apply 9Router as openai-compatible provider (multi-model support)
export async function POST(request) {
  try {
    const { baseUrl, apiKey, model, models, activeModel, subagentModel } = await request.json();

    // Accept either `model` (string, legacy) or `models` (array of strings)
    const modelsArray = Array.isArray(models) ? models.slice() : (typeof model === "string" ? [model] : []);

    if (!baseUrl || modelsArray.length === 0) {
      return NextResponse.json({ error: "baseUrl and at least one model are required" }, { status: 400 });
    }

    const configDir = getConfigDir();
    const configPath = getConfigPath();

    await fs.mkdir(configDir, { recursive: true });

    // Read existing config or start fresh
    let config = {};
    try {
      const existing = await fs.readFile(configPath, "utf-8");
      config = JSON.parse(existing);
    } catch { /* No existing config */ }

    const normalizedBaseUrl = baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
    const keyToUse = apiKey || "sk_krouter";
    const effectiveSubagentModel = subagentModel || modelsArray[0];

    // Ensure provider object
    if (!config.provider) config.provider = {};

    // Preserve any existing krouter (or legacy 9router) provider entry and its models
    const existingProvider = getProviderEntry(config) || { npm: "@ai-sdk/openai-compatible", options: {}, models: {} };

    // Merge options (overwrite baseURL/apiKey)
    existingProvider.options = {
      ...existingProvider.options,
      baseURL: normalizedBaseUrl,
      apiKey: keyToUse,
    };

    // Ensure models map exists
    existingProvider.models = existingProvider.models || {};

    // Add or update entries for all requested models
    for (const m of modelsArray) {
      if (!m || typeof m !== "string") continue;
      existingProvider.models[m] = { name: m, modalities: { input: ["text", "image"], output: ["text"] } };
    }

    // Save merged provider back under the new key; remove legacy key if present.
    config.provider[PROVIDER_KEY] = existingProvider;
    delete config.provider[LEGACY_PROVIDER_KEY];

    // Set the active model: prefer explicit activeModel, else first of modelsArray
    // If activeModel is explicitly empty string, clear the model
    if (activeModel === "") {
      config.model = "";
    } else {
      const finalActive = activeModel || modelsArray[0];
      if (finalActive) {
        config.model = `${MODEL_PREFIX}${finalActive}`;
      }
    }

    // Add subagent configuration
    if (!config.agent) config.agent = {};
    config.agent.explorer = {
      description: "Fast explorer subagent for codebase exploration",
      mode: "subagent",
      model: `${MODEL_PREFIX}${effectiveSubagentModel}`,
    };

    await fs.writeFile(configPath, JSON.stringify(config, null, 2));

    return NextResponse.json({
      success: true,
      message: "OpenCode settings applied successfully!",
      configPath,
    });
  } catch (error) {
    console.log("Error applying opencode settings:", error);
    return NextResponse.json({ error: "Failed to apply settings" }, { status: 500 });
  }
}

// PATCH - Update specific settings (e.g., clear active model)
export async function PATCH(request) {
  try {
    const { clearActiveModel } = await request.json();
    const configPath = getConfigPath();

    let config = {};
    try {
      const existing = await fs.readFile(configPath, "utf-8");
      config = JSON.parse(existing);
    } catch (error) {
      if (error.code === "ENOENT") {
        return NextResponse.json({ success: true, message: "No config file found" });
      }
      throw error;
    }

    if (clearActiveModel === true) {
      // Clear active model but keep models in the list
      if (MODEL_PREFIX_RE.test(config.model || "")) {
        config.model = "";
      }
    }

    await fs.writeFile(configPath, JSON.stringify(config, null, 2));

    return NextResponse.json({
      success: true,
      message: "Settings updated",
    });
  } catch (error) {
    console.log("Error patching opencode settings:", error);
    return NextResponse.json({ error: "Failed to patch settings" }, { status: 500 });
  }
}

// DELETE - Remove 9Router provider or specific models from config
export async function DELETE(request) {
  try {
    const { searchParams } = new URL(request.url);
    const modelToRemove = searchParams.get("model");
    const configPath = getConfigPath();

    let config = {};
    try {
      const existing = await fs.readFile(configPath, "utf-8");
      config = JSON.parse(existing);
    } catch (error) {
      if (error.code === "ENOENT") {
        return NextResponse.json({ success: true, message: "No config file to reset" });
      }
      throw error;
    }

    // Resolve which key currently holds the provider entry (krouter or legacy 9router)
    const providerEntry = getProviderEntry(config);
    const activeProviderKey = config.provider?.[PROVIDER_KEY] ? PROVIDER_KEY : (config.provider?.[LEGACY_PROVIDER_KEY] ? LEGACY_PROVIDER_KEY : null);

    // If specific model provided, remove just that model
    if (modelToRemove && providerEntry?.models && activeProviderKey) {
      delete providerEntry.models[modelToRemove];

      // If no models left, remove the provider
      if (Object.keys(providerEntry.models).length === 0) {
        delete config.provider[PROVIDER_KEY];
        delete config.provider[LEGACY_PROVIDER_KEY];
        if (MODEL_PREFIX_RE.test(config.model || "")) delete config.model;
      } else if (
        config.model === `${MODEL_PREFIX}${modelToRemove}` ||
        config.model === `9router/${modelToRemove}`
      ) {
        // If removed model was active, switch to first remaining model
        const remainingModels = Object.keys(providerEntry.models);
        config.model = `${MODEL_PREFIX}${remainingModels[0]}`;
      }
    } else {
      // No specific model - remove entire kRouter provider (both new and legacy keys)
      if (config.provider) {
        delete config.provider[PROVIDER_KEY];
        delete config.provider[LEGACY_PROVIDER_KEY];
      }
      if (MODEL_PREFIX_RE.test(config.model || "")) delete config.model;
    }

    // Remove subagent configuration if it points at our provider
    if (MODEL_PREFIX_RE.test(config.agent?.explorer?.model || "")) {
      delete config.agent.explorer;
      // Clean up empty agent object
      if (Object.keys(config.agent).length === 0) delete config.agent;
    }

    await fs.writeFile(configPath, JSON.stringify(config, null, 2));

    return NextResponse.json({
      success: true,
      message: modelToRemove ? `Model "${modelToRemove}" removed` : "kRouter settings removed from OpenCode",
    });
  } catch (error) {
    console.log("Error resetting opencode settings:", error);
    return NextResponse.json({ error: "Failed to reset opencode settings" }, { status: 500 });
  }
}
