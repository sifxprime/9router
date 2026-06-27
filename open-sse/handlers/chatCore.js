import { detectFormat, getTargetFormat } from "../services/provider.js";
import { translateRequest } from "../translator/index.js";
import { FORMATS } from "../translator/formats.js";
import { normalizeClaudePassthrough } from "../translator/helpers/claudeHelper.js";
import { bodyHasInvalidToolIds, ensureToolCallIds } from "../translator/helpers/toolCallHelper.js";
import { COLORS } from "../utils/stream.js";
import { createStreamController } from "../utils/streamHandler.js";
import { refreshWithRetry } from "../services/tokenRefresh.js";
import { createRequestLogger } from "../utils/requestLogger.js";
import { getModelTargetFormat, getModelStrip, getModelUpstreamId, getModelType, PROVIDER_ID_TO_ALIAS } from "../config/providerModels.js";
import { createErrorResult, parseUpstreamError, formatProviderError } from "../utils/error.js";
import { resolveDeprecatedModel } from "../services/modelDeprecation.js";
import { stripUnsupportedFields } from "../services/modelStrip.js";
import { HTTP_STATUS } from "../config/runtimeConfig.js";
import { handleBypassRequest } from "../utils/bypassHandler.js";
import { trackPendingRequest, appendRequestLog, saveRequestDetail } from "@/lib/usageDb.js";
import { getExecutor } from "../executors/index.js";
import { acquire as acquireAccountSlot, buildAccountSemaphoreKey, markBlocked as markAccountBlocked } from "../services/accountSemaphore.js";
import { shouldUseEmergencyFallback, buildEmergencyFallbackConfig } from "../services/emergencyFallback.js";
import { generateSessionId as deriveUserSessionId, touchSession } from "../services/sessionManager.js";
import { buildRequestDetail, extractRequestConfig } from "./chatCore/requestDetail.js";
import { handleForcedSSEToJson } from "./chatCore/sseToJsonHandler.js";
import { handleNonStreamingResponse } from "./chatCore/nonStreamingHandler.js";
import { handleStreamingResponse, buildOnStreamComplete } from "./chatCore/streamingHandler.js";
import { detectClientTool, isNativePassthrough } from "../utils/clientDetector.js";
import { dedupeTools } from "../utils/toolDeduper.js";
import { injectCaveman } from "../rtk/caveman.js";
import { injectPonytail } from "../rtk/ponytail.js";
import { compressMessages, formatRtkLog } from "../rtk/index.js";

/**
 * Core chat handler - shared between SSE and Worker
 * @param {object} options.body - Request body
 * @param {object} options.modelInfo - { provider, model }
 * @param {object} options.credentials - Provider credentials
 * @param {string} options.sourceFormatOverride - Override detected source format (e.g. "openai-responses")
 */
export async function handleChatCore({ body, modelInfo, credentials, log, onCredentialsRefreshed, onRequestSuccess, onDisconnect, clientRawRequest, connectionId, userAgent, apiKey, ccFilterNaming, rtkEnabled, cavemanEnabled, cavemanLevel, ponytailEnabled, ponytailLevel, sourceFormatOverride, providerThinking, settings = null }) {
  const { provider, model } = modelInfo;
  const requestStartTime = Date.now();

  const sourceFormat = sourceFormatOverride || detectFormat(body);

  // Check for bypass patterns (warmup, skip, cc naming)
  const bypassResponse = handleBypassRequest(body, model, userAgent, ccFilterNaming);
  if (bypassResponse) return bypassResponse;

  const alias = PROVIDER_ID_TO_ALIAS[provider] || provider;
  const modelTargetFormat = getModelTargetFormat(alias, model);
  const targetFormat = modelTargetFormat || getTargetFormat(provider);
  const stripList = getModelStrip(alias, model);
  // Model Deprecation (0.5.31): auto-upgrade legacy models to their successors
  const upstreamModelRaw = getModelUpstreamId(alias, model);
  const upstreamModel = resolveDeprecatedModel(upstreamModelRaw) || upstreamModelRaw;
  if (upstreamModel !== upstreamModelRaw) {
    log?.debug?.("MODEL", `auto-upgraded deprecated model: ${upstreamModelRaw} → ${upstreamModel}`);
  }

  // Inject provider-level thinking config override (only if client hasn't set)
  // on/off → extended type (body.thinking), none/low/medium/high → effort type (body.reasoning_effort)
  if (providerThinking?.mode && providerThinking.mode !== "auto") {
    const mode = providerThinking.mode;
    if (mode === "on" && !body.thinking) {
      console.log("Injecting provider-level thinking config override: on");
      body = { ...body, thinking: { type: "enabled", budget_tokens: 10000 } };
    } else if (mode === "off" && !body.thinking) {
      body = { ...body, thinking: { type: "disabled" } };
    } else if (!body.reasoning_effort) {
      body = { ...body, reasoning_effort: mode };
    }
  }

  const clientRequestedStreaming = body.stream === true || sourceFormat === FORMATS.ANTIGRAVITY || sourceFormat === FORMATS.GEMINI || sourceFormat === FORMATS.GEMINI_CLI;
  const providerRequiresStreaming = provider === "openai" || provider === "codex" || provider === "commandcode";
  let stream = providerRequiresStreaming ? true : (body.stream !== false);

  // DeepSeek-TUI: interactive TUI panel sends stream:true and needs SSE.
  // Non-interactive mode (-p flag) sends without stream and can't parse SSE.
  // Only force non-streaming when client didn't explicitly request it.
  const detectedTool = detectClientTool(clientRawRequest?.headers || {}, body);
  if (detectedTool === "deepseek-tui" && body.stream !== true) stream = false;

  // Check client Accept header preference for non-streaming requests
  // This fixes AI SDK compatibility where clients send Accept: application/json
  const acceptHeader = clientRawRequest?.headers?.accept || "";
  const clientPrefersJson = acceptHeader.includes("application/json");
  const clientPrefersSSE = acceptHeader.includes("text/event-stream");
  if (clientPrefersJson && !clientPrefersSSE && body.stream !== true) {
    stream = false;
  }

  const reqLogger = await createRequestLogger(sourceFormat, targetFormat, model);
  if (clientRawRequest) reqLogger.logClientRawRequest(clientRawRequest.endpoint, clientRawRequest.body, clientRawRequest.headers);
  reqLogger.logRawRequest(body);
  log?.debug?.("FORMAT", `${sourceFormat} → ${targetFormat} | stream=${stream}`);

  // Native passthrough: CLI tool and provider are the same ecosystem
  // Skip all translation/normalization — only model and Bearer are swapped
  const clientTool = detectClientTool(clientRawRequest?.headers || {}, body);
  const passthrough = isNativePassthrough(clientTool, provider);

  // 0.5.33 — cacheControlMode: "auto" | "always" | "never" (see settingsRepo).
  // Hoisted up so the translateRequest call below can pass preserveCacheControl.
  const cacheControlMode = settings?.cacheControlMode || "auto";

  const isClaudeShapeUpstream = provider === "claude" || (typeof provider === "string" && provider.startsWith("anthropic-compatible"));
  const isClaudeDirectCachePath =
    cacheControlMode === "never" ? false :
    cacheControlMode === "always" ? isClaudeShapeUpstream :
    /* "auto" */ (passthrough && clientTool === "claude" && provider === "claude");

  let translatedBody;
  let toolNameMap;
  if (passthrough) {
    log?.debug?.("PASSTHROUGH", `${clientTool} → ${provider} | native lossless`);
    translatedBody = { ...body, model: upstreamModel };
    // Normalize newer Cowork/CC beta shapes (adaptive thinking, mid-conversation system) the API rejects
    if (clientTool === "claude" && !isClaudeDirectCachePath) normalizeClaudePassthrough(translatedBody, upstreamModel);

    // 0.5.63 — fix the "Google → Claude tool_use.id format" cross-IDE bug.
    // When a conversation started in Antigravity/Gemini (which emits IDs with
    // dots, colons, slashes) and is later continued via Claude direct passthrough,
    // Anthropic rejects the request with 400 invalid_request_error on
    // `messages.N.content.M.tool_use.id` because of the regex ^[a-zA-Z0-9_-]+$.
    // The general translator path already runs ensureToolCallIds(), but
    // passthrough skipped it (especially when cache-preserve was on). We only
    // pay the mutation cost when bodyHasInvalidToolIds() returns true — clean
    // Claude-only conversations are byte-identical and prompt cache survives.
    if (isClaudeShapeUpstream && bodyHasInvalidToolIds(translatedBody)) {
      log?.warn?.("TOOLS", `${clientTool} → ${provider} | sanitizing tool_use IDs (Gemini-style chars detected)`);
      ensureToolCallIds(translatedBody);
    }
  } else {
    // 0.5.33 — pass cacheControlMode=="always" to skip cache_control mutations
    // on the translated Claude-shape request as well as the passthrough path.
    translatedBody = translateRequest(sourceFormat, targetFormat, upstreamModel, body, stream, credentials, provider, reqLogger, stripList, connectionId, clientTool, cacheControlMode === "always");
    if (!translatedBody) {
      trackPendingRequest(model, provider, connectionId, false, true);
      return createErrorResult(HTTP_STATUS.BAD_REQUEST, `Failed to translate request for ${sourceFormat} → ${targetFormat}`);
    }
    toolNameMap = translatedBody._toolNameMap;
    delete translatedBody._toolNameMap;
    translatedBody.model = upstreamModel;
    if (translatedBody.stream === undefined) translatedBody.stream = stream;
  }

  // Dedupe duplicate built-in tools when equivalent MCP tools are present (Claude clients only).
  if (clientTool === "claude" && !isClaudeDirectCachePath && Array.isArray(translatedBody.tools)) {
    const { tools: deduped, stripped } = dedupeTools(translatedBody.tools);
    if (stripped.length > 0) {
      translatedBody.tools = deduped;
      log?.debug?.("TOOLDEDUP", `stripped ${stripped.length}: ${stripped.slice(0, 3).join(", ")}${stripped.length > 3 ? "..." : ""}`);
    }
  }

  // Token savers: applied at the final body just before dispatch
  // Covers both passthrough (source shape) and translated (target shape) flows
  const finalFormat = passthrough ? sourceFormat : targetFormat;

  // 0.5.32 — Claude direct cache preservation (gated by 0.5.33 cacheControlMode)
  // When client is Claude Desktop / Claude Code talking to the real Anthropic
  // API, every byte of the outbound request body is part of Anthropic's prompt
  // cache key. Any mutation here (RTK trimming tool_results, Caveman injecting
  // a system block, Ponytail injecting another) shifts the byte sequence, busts
  // the cache, and the user is billed for full re-tokenisation of every cached
  // prefix on every turn.
  //
  // Mode behavior:
  //   "auto"   (default): skip mutations ONLY for Claude direct passthrough
  //   "always": skip mutations for ANY claude-target request (paranoid mode —
  //             useful when routing through anthropic-compatible-cc-* resellers
  //             that also cache aggressively)
  //   "never":  legacy — always mutate even on Claude direct (escape hatch if
  //             an upstream ever rejects our cache_control markers)
  // cacheControlMode is hoisted above (line ~104) so translateRequest sees it.
  // TTS models don't support tool messages/function calling
  if (getModelType(alias, model) === "tts" && translatedBody.messages) {
    translatedBody.messages = translatedBody.messages.filter(msg => msg.role !== "tool");
    delete translatedBody.tools;
  }

  if (isClaudeDirectCachePath) {
    log?.debug?.("CACHE", `mode=${cacheControlMode} | token savers SKIPPED to preserve upstream prompt cache (${clientTool} → ${provider})`);
  } else {
    // RTK: compress tool_result content
    const rtkStats = compressMessages(translatedBody, rtkEnabled);
    const rtkLine = formatRtkLog(rtkStats);
    if (rtkLine) log?.debug?.("RTK", rtkLine);

    // Caveman: inject terse-style system prompt
    if (cavemanEnabled && cavemanLevel) {
      injectCaveman(translatedBody, finalFormat, cavemanLevel);
      log?.debug?.("CAVEMAN", `${cavemanLevel} | ${finalFormat}`);
    }

    // Ponytail: inject "lazy senior dev" persona for minimal-code outputs.
    // Sister feature to Caveman — same injection layer, different style.
    // Caveman = terse outputs (general). Ponytail = minimal code (engineering).
    // Both can be enabled together; ladder + persistence guidance compose
    // because they target different aspects of the response.
    if (ponytailEnabled && ponytailLevel) {
      injectPonytail(translatedBody, finalFormat, ponytailLevel);
      log?.debug?.("PONYTAIL", `${ponytailLevel} | ${finalFormat}`);
    }
  }

  // Model Strip (0.5.31): proactively drop fields that break specific providers
  // (e.g. Groq rejecting logprobs) so the request doesn't instantly 400.
  translatedBody = stripUnsupportedFields(translatedBody, provider);

  const executor = getExecutor(provider);
  trackPendingRequest(model, provider, connectionId, true);
  appendRequestLog({ model, provider, connectionId, status: "PENDING" }).catch(() => { });

  const msgCount = translatedBody.messages?.length || translatedBody.input?.length || translatedBody.contents?.length || translatedBody.request?.contents?.length || 0;
  log?.debug?.("REQUEST", `${provider.toUpperCase()} | ${model} | ${msgCount} msgs`);

  const streamController = createStreamController({
    onDisconnect: (reason) => {
      trackPendingRequest(model, provider, connectionId, false);
      if (onDisconnect) onDisconnect(reason);
    },
    onError: () => trackPendingRequest(model, provider, connectionId, false),
    log, provider, model
  });

  const proxyOptions = {
    connectionProxyEnabled: credentials?.providerSpecificData?.connectionProxyEnabled === true,
    connectionProxyUrl: credentials?.providerSpecificData?.connectionProxyUrl || "",
    connectionNoProxy: credentials?.providerSpecificData?.connectionNoProxy || "",
    vercelRelayUrl: credentials?.providerSpecificData?.vercelRelayUrl || "",
  };

  if (proxyOptions.vercelRelayUrl) {
    const connectionName = credentials?.connectionName || credentials?.connectionId || "unknown";
    const poolId = credentials?.providerSpecificData?.connectionProxyPoolId || "none";
    log?.info?.("PROXY", `${provider.toUpperCase()} | ${model} | conn=${connectionName} | pool=${poolId} | vercel-relay=${proxyOptions.vercelRelayUrl}`);
  } else if (proxyOptions.connectionProxyEnabled && proxyOptions.connectionProxyUrl) {
    let maskedProxyUrl = proxyOptions.connectionProxyUrl;
    try {
      const parsed = new URL(proxyOptions.connectionProxyUrl);
      const host = parsed.hostname || "";
      const port = parsed.port ? `:${parsed.port}` : "";
      const protocol = parsed.protocol || "http:";
      maskedProxyUrl = `${protocol}//${host}${port}`;
    } catch {
      // Keep raw if URL parsing fails
    }

    const poolId = credentials?.providerSpecificData?.connectionProxyPoolId || "none";
    const connectionName = credentials?.connectionName || credentials?.connectionId || "unknown";
    log?.info?.("PROXY", `${provider.toUpperCase()} | ${model} | conn=${connectionName} | pool=${poolId} | url=${maskedProxyUrl}`);
  }

  if (proxyOptions.connectionProxyEnabled && proxyOptions.connectionNoProxy) {
    const connectionName = credentials?.connectionName || credentials?.connectionId || "unknown";
    log?.debug?.("PROXY", `${provider.toUpperCase()} | ${model} | conn=${connectionName} | no_proxy=${proxyOptions.connectionNoProxy}`);
  }

  // Execute request — wrapped with account semaphore so parallel requests
  // to the same (provider, account) don't all hammer it at once. Concurrency
  // resolution order (lowest precedence first):
  //   1. Global default per provider (HEAVY_RATE_LIMIT for free/quota-tight,
  //      MODERATE for OAuth, BYPASS for paid API-key).
  //   2. credentials.providerSpecificData.maxConcurrency override (per-account).
  // Pass maxConcurrency<=0 / null to bypass entirely (no-op release).
  // 0.5.42 — Bumped Kiro 2→4 and Claude 3→5 after a real user log showed
  // an IDE Autopilot loop saturating all 12 Kiro slots (2 × 6 accounts) and
  // every combo retry hitting a 5s semaphore timeout for ~25s total.
  // Kiro requests take ~28s so 2 slots/account caps throughput at ~4 req/min
  // per account — nowhere near enough for an IDE that fans out parallel.
  const PROVIDER_CONCURRENCY_DEFAULTS = {
    antigravity: 2, kiro: 4, claude: 5, codex: 3,
    "mimo-free": 1, opencode: 1,
    "gemini-cli": 2, qoder: 2,
  };
  // 0.5.42 — Per-provider semaphore timeout. The 5s default in 0.5.41 was too
  // short for providers whose typical request is 20-30s. When all slots are in
  // flight on long requests, 5s always times out before one frees → cascade of
  // 503 "busy" loops. Pick a value close to typical request duration so a
  // freeing slot is actually catchable.
  const SEMAPHORE_TIMEOUT_DEFAULTS = {
    antigravity: 5_000,  // antigravity is fast (~2-5s typical)
    kiro: 20_000,        // kiro is slow (~28s typical) — wait long enough to catch
    claude: 15_000,      // claude is medium-slow
    codex: 15_000,
    "mimo-free": 10_000,
    opencode: 10_000,
    "gemini-cli": 10_000,
    qoder: 10_000,
  };
  const perAccountConcurrency = Number(credentials?.providerSpecificData?.maxConcurrency);
  const concurrency = Number.isFinite(perAccountConcurrency) && perAccountConcurrency > 0
    ? perAccountConcurrency
    : PROVIDER_CONCURRENCY_DEFAULTS[provider] || 0; // 0 = bypass for unlisted providers
  const semaphoreTimeoutMs = SEMAPHORE_TIMEOUT_DEFAULTS[provider] || 10_000;
  const semaphoreKey = buildAccountSemaphoreKey(provider, connectionId || "noauth");
  let releaseSlot = () => {};
  try {
    releaseSlot = await acquireAccountSlot(semaphoreKey, {
      maxConcurrency: concurrency,
      timeoutMs: semaphoreTimeoutMs,
      signal: streamController.signal,
    });
  } catch (e) {
    if (e?.code === "SEMAPHORE_QUEUE_FULL" || e?.code === "SEMAPHORE_TIMEOUT") {
      // Block this account briefly so the picker skips it on the very next
      // retry — but only for a fraction of the timeout, since the in-flight
      // request that owns the slot is likely about to finish.
      const blockMs = Math.max(2_000, Math.round(semaphoreTimeoutMs / 2));
      markAccountBlocked(semaphoreKey, blockMs);
      log?.warn?.("AUTH", `${provider} | account ${connectionId?.slice(0,8)} busy — blocked ${blockMs}ms, picker will skip`);
      trackPendingRequest(model, provider, connectionId, false, true);
      return createErrorResult(HTTP_STATUS.SERVICE_UNAVAILABLE, `Account ${connectionId?.slice(0,8)} busy, try another`);
    }
    throw e;
  }

  // Execute request — semaphore released via releaseOnce in every return path
  // below. We don't wrap everything in a try/finally because streaming
  // returns a still-flowing Response object whose stream is consumed by the
  // caller, after which we can't easily hook a release.
  let providerResponse, providerUrl, providerHeaders, finalBody;
  let slotReleased = false;
  const releaseOnce = () => {
    if (slotReleased) return;
    slotReleased = true;
    try { releaseSlot(); } catch { /* ignore */ }
  };
  // 0.5.29 — session tracker. Generates a deterministic id from
  // (model, system, tools, first user msg, provider, connection) and
  // touches the in-memory session pool. Same conversation continuing on
  // the same account → same session id → enables sticky routing,
  // prompt-cache continuity, and per-key concurrency tracking.
  const userSessionId = deriveUserSessionId(translatedBody, { provider, connectionId });
  if (userSessionId) {
    touchSession(userSessionId, connectionId, apiKey);
    log?.debug?.("SESSION", `sid=${userSessionId.slice(0, 12)} conn=${connectionId?.slice(0, 8) || "noauth"}`);
  }

  try {
    const result = await executor.execute({ model, body: translatedBody, stream, credentials, signal: streamController.signal, log, proxyOptions });
    providerResponse = result.response;
    providerUrl = result.url;
    providerHeaders = result.headers;
    finalBody = result.transformedBody;
    reqLogger.logTargetRequest(providerUrl, providerHeaders, finalBody);
  } catch (error) {
    releaseOnce();
    trackPendingRequest(model, provider, connectionId, false, true);
    appendRequestLog({ model, provider, connectionId, status: `FAILED ${error.name === "AbortError" ? 499 : HTTP_STATUS.BAD_GATEWAY}` }).catch(() => { });
    saveRequestDetail(buildRequestDetail({
      provider, model, connectionId,
      latency: { ttft: 0, total: Date.now() - requestStartTime },
      tokens: { prompt_tokens: 0, completion_tokens: 0 },
      request: extractRequestConfig(body, stream),
      providerRequest: translatedBody || null,
      response: { error: error.message || String(error), status: error.name === "AbortError" ? 499 : 502, thinking: null },
      status: "error"
    })).catch(() => { });

    if (error.name === "AbortError") {
      streamController.handleError(error);
      return createErrorResult(499, "Request aborted");
    }
    const errMsg = formatProviderError(error, provider, model, HTTP_STATUS.BAD_GATEWAY);
    console.log(`${COLORS.red}[ERROR] ${errMsg}${COLORS.reset}`);
    return createErrorResult(HTTP_STATUS.BAD_GATEWAY, errMsg);
  }

  // Handle 401/403 - try token refresh (skip for noAuth providers)
  if (!executor.noAuth && (providerResponse.status === HTTP_STATUS.UNAUTHORIZED || providerResponse.status === HTTP_STATUS.FORBIDDEN)) {
    try {
      const newCredentials = await refreshWithRetry(() => executor.refreshCredentials(credentials, log), 3, log);
      if (newCredentials?.accessToken || newCredentials?.copilotToken) {
        log?.info?.("TOKEN", `${provider.toUpperCase()} | refreshed`);
        // Immutable update — never mutate the caller's credentials object.
        // Concurrent requests sharing the same reference must not see each other's tokens.
        const updatedCredentials = { ...credentials, ...newCredentials };
        if (onCredentialsRefreshed) {
          try { await onCredentialsRefreshed(newCredentials); } catch (e) { log?.warn?.("TOKEN", `onCredentialsRefreshed failed: ${e.message}`); }
        }
        try {
          const retryResult = await executor.execute({ model, body: translatedBody, stream, credentials: updatedCredentials, signal: streamController.signal, log, proxyOptions });
          // Always adopt the retry result — even on non-ok. The retry's error is
          // the real reason the user's request failed; the original 401 body is
          // stale and was only ever a refresh trigger. Downstream parseUpstreamError
          // will surface this fresher error to the client.
          providerResponse = retryResult.response;
          providerUrl = retryResult.url;
          if (!providerResponse.ok) {
            log?.warn?.("TOKEN", `${provider.toUpperCase()} | retry after refresh still failed: ${providerResponse.status}`);
          }
        } catch (retryErr) {
          log?.warn?.("TOKEN", `${provider.toUpperCase()} | retry after refresh threw: ${retryErr.message}`);
          // Synthesize a response so downstream error handling surfaces the
          // actual cause instead of the stale 401.
          providerResponse = new Response(
            JSON.stringify({ error: { message: `Retry after token refresh threw: ${retryErr.message}`, type: "retry_exception" } }),
            { status: HTTP_STATUS.BAD_GATEWAY, headers: { "Content-Type": "application/json" } }
          );
        }
      } else {
        log?.warn?.("TOKEN", `${provider.toUpperCase()} | refresh failed`);
      }
    } catch (e) {
      log?.warn?.("TOKEN", `${provider.toUpperCase()} | refresh threw: ${e.message}`);
    }
  }

  // Provider returned error
  if (!providerResponse.ok) {
    trackPendingRequest(model, provider, connectionId, false, true);
    const { statusCode, message, resetsAtMs } = await parseUpstreamError(providerResponse, executor);
    appendRequestLog({ model, provider, connectionId, status: `FAILED ${statusCode}` }).catch(() => { });
    saveRequestDetail(buildRequestDetail({
      provider, model, connectionId,
      latency: { ttft: 0, total: Date.now() - requestStartTime },
      tokens: { prompt_tokens: 0, completion_tokens: 0 },
      request: extractRequestConfig(body, stream),
      providerRequest: finalBody || translatedBody || null,
      response: { error: message, status: statusCode, thinking: null },
      status: "error"
    })).catch(() => { });

    const errMsg = formatProviderError(new Error(message), provider, model, statusCode);
    console.log(`${COLORS.red}[ERROR] ${errMsg}${COLORS.reset}`);
    reqLogger.logError(new Error(message), finalBody || translatedBody);
    releaseOnce();

    // Emergency fallback (0.5.28): on 402 / budget exhaustion, optionally
    // attach a redirect hint so chat.js can re-route to a free model. The
    // settings flag governs whether this is enabled; loop protection via
    // body.__emergencyFallbackUsed (set in chat.js when honoring this hint).
    let emergencyFallback;
    if (!body?.__emergencyFallbackUsed) {
      const requestHasTools = Array.isArray(body?.tools) && body.tools.length > 0;
      const cfg = buildEmergencyFallbackConfig(settings);
      const decision = shouldUseEmergencyFallback(statusCode, message || "", requestHasTools, cfg);
      if (decision.shouldFallback) {
        emergencyFallback = {
          provider: decision.provider,
          model: decision.model,
          reason: decision.reason,
          maxOutputTokens: decision.maxOutputTokens,
        };
        log?.info?.("EMERGENCY", `${provider}/${model} → ${decision.reason}`);
      }
    }
    return createErrorResult(statusCode, errMsg, resetsAtMs, emergencyFallback ? { emergencyFallback } : {});
  }

  // Success — release the semaphore slot before the downstream handler
  // consumes the response (the upstream call itself is done; new requests
  // to this account can begin in parallel with the stream the user receives).
  releaseOnce();

  const sharedCtx = { provider, model, body, stream, translatedBody, finalBody, requestStartTime, connectionId, apiKey, clientRawRequest, onRequestSuccess };
  const appendLog = (extra) => appendRequestLog({ model, provider, connectionId, ...extra }).catch(() => { });
  const trackDone = () => trackPendingRequest(model, provider, connectionId, false);

  // Provider forced streaming but client wants JSON
  if (!clientRequestedStreaming && providerRequiresStreaming) {
    const result = await handleForcedSSEToJson({ ...sharedCtx, providerResponse, sourceFormat, trackDone, appendLog });
    if (result) { streamController.handleComplete(); return result; }
  }

  // True non-streaming response
  if (!stream) {
    const result = await handleNonStreamingResponse({ ...sharedCtx, providerResponse, sourceFormat, targetFormat, reqLogger, toolNameMap, trackDone, appendLog });
    streamController.handleComplete();
    return result;
  }

  // Streaming response
  const { onStreamComplete } = buildOnStreamComplete({ ...sharedCtx });
  return handleStreamingResponse({ ...sharedCtx, providerResponse, sourceFormat, targetFormat, userAgent, reqLogger, toolNameMap, streamController, onStreamComplete });
}

export function isTokenExpiringSoon(expiresAt, bufferMs = 5 * 60 * 1000) {
  if (!expiresAt) return false;
  return new Date(expiresAt).getTime() - Date.now() < bufferMs;
}
