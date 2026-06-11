import { proxyAwareFetch } from "../utils/proxyFetch.js";

const DEFAULT_PROXY_URL = "http://localhost:8787";
const DEFAULT_CLOUD_URL = "https://api.headroom.ai";
const PROBE_TTL_MS = 30_000;
const COMPRESS_TIMEOUT_MS = 5_000;

function resolveHeadroomBaseUrl() {
  const configured = process.env.HEADROOM_BASE_URL?.trim();
  if (configured) return configured;
  if (process.env.HEADROOM_API_KEY?.trim()) return DEFAULT_CLOUD_URL;
  return DEFAULT_PROXY_URL;
}

function headroomCompressOptions(model) {
  const apiKey = process.env.HEADROOM_API_KEY?.trim();
  const baseUrl = resolveHeadroomBaseUrl();
  return apiKey ? { model, apiKey, baseUrl } : { model, baseUrl };
}

function isHeadroomCloudConfigured() {
  return !!process.env.HEADROOM_API_KEY?.trim();
}

let compressFn = null;
let compressLoaded = false;
const probeCacheByUrl = new Map();

async function loadCompress() {
  if (compressLoaded) return compressFn;
  compressLoaded = true;
  try {
    const mod = await import("headroom-ai");
    compressFn = mod.compress ?? mod.default?.compress ?? null;
  } catch {
    compressFn = null;
  }
  return compressFn;
}

async function probeProxy(baseUrl = resolveHeadroomBaseUrl()) {
  if (isHeadroomCloudConfigured()) return true;
  const now = Date.now();
  const cached = probeCacheByUrl.get(baseUrl);
  if (cached && now - cached.ts < PROBE_TTL_MS) return cached.reachable;
  let reachable = false;
  try {
    const res = await proxyAwareFetch(`${baseUrl}/health`, {
      signal: AbortSignal.timeout(1500),
      cache: "no-store",
    }, null);
    reachable = res.ok;
  } catch {
    reachable = false;
  }
  probeCacheByUrl.set(baseUrl, { reachable, ts: now });
  return reachable;
}

export function invalidateHeadroomProbe() {
  probeCacheByUrl.clear();
}

function invalidateProbe() {
  invalidateHeadroomProbe();
}

function tailHasToolHistory(messages) {
  for (const msg of messages) {
    if (msg?.role === "tool") return true;
    if (Array.isArray(msg?.tool_calls) && msg.tool_calls.length > 0) return true;
    if (!Array.isArray(msg?.content)) continue;
    if (msg.content.some((block) => block?.type === "tool_use" || block?.type === "tool_result")) {
      return true;
    }
  }
  return false;
}

function shouldSkipHeadroomForMessages(messages) {
  const cacheFloor = findCacheFloor(messages);
  const tail = messages.slice(cacheFloor + 1);
  if (tail.length === 0) return true;
  if (tail.every((m) => m?.role === "system" || m?.role === "developer")) return true;
  if (tailHasToolHistory(tail)) return true;
  return false;
}

function shouldSkipHeadroomForInput(input) {
  const cacheFloor = findCacheFloor(input);
  const tail = input.slice(cacheFloor + 1);
  if (tail.length === 0) return true;
  const messageRoles = tail
    .filter((item) => item?.type === "message")
    .map((item) => item.role);
  if (messageRoles.length === 0) return true;
  if (messageRoles.every((role) => role === "system" || role === "developer")) return true;
  return false;
}

// Returns the index of the last message/item carrying a cache_control marker.
function findCacheFloor(arr) {
  for (let i = arr.length - 1; i >= 0; i--) {
    const item = arr[i];
    if (!item) continue;
    if (item.cache_control) return i;
    if (Array.isArray(item.content)) {
      for (const part of item.content) {
        if (part?.cache_control) return i;
      }
    }
  }
  return -1;
}

function cloneForCompress(value) {
  return structuredClone(value);
}

function compressedMessageText(msg) {
  if (typeof msg?.content === "string") return msg.content;
  if (Array.isArray(msg?.content)) {
    return msg.content.map((part) => part?.text || "").filter(Boolean).join("");
  }
  return "";
}

function applyCompressedTextToInputItem(item, compressedMsg) {
  const text = compressedMessageText(compressedMsg);
  const updated = cloneForCompress(item);
  if (typeof updated.content === "string") {
    updated.content = text;
    return updated;
  }
  if (Array.isArray(updated.content)) {
    for (const part of updated.content) {
      if (!part) continue;
      if (part.text !== undefined) {
        part.text = text;
        return updated;
      }
      if (part.input_text !== undefined) {
        part.input_text = text;
        return updated;
      }
      if (part.output_text !== undefined) {
        part.output_text = text;
        return updated;
      }
    }
    if (text) updated.content = [{ type: "input_text", text }];
  }
  return updated;
}

// Run headroom on a tail of Chat Completions messages[] (caller must pass a clone).
async function compressTail(tail, model, compress) {
  const before = JSON.stringify(tail).length;
  const result = await Promise.race([
    compress(tail, headroomCompressOptions(model)),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("headroom timeout")), COMPRESS_TIMEOUT_MS)
    ),
  ]);
  if (!result?.messages) return null;
  const after = JSON.stringify(result.messages).length;
  return { compressed: result.messages, before, after, saved: before - after };
}

// Compress body.messages (Chat Completions / Claude format).
async function compressMessagesBody(body, model, compress) {
  const messages = body.messages;
  const cacheFloor = findCacheFloor(messages);
  const head = messages.slice(0, cacheFloor + 1);
  const tail = messages.slice(cacheFloor + 1);
  if (tail.length < 1) return null;

  try {
    const r = await compressTail(cloneForCompress(tail), model, compress);
    if (!r || r.saved <= 0) return null;
    body.messages = [...head, ...r.compressed];
    return { before: r.before, after: r.after, saved: r.saved };
  } catch (err) {
    console.warn("[HEADROOM] compressMessagesBody failed:", err?.message || err);
    invalidateProbe();
    return null;
  }
}

// Compress body.input (OpenAI Responses API format).
// Strategy:
//   1. Find the cache floor in the input array (do not touch items at or before it).
//   2. Extract user/assistant message items from the compressible tail into a
//      temporary messages[] and send them to headroom.
//   3. If headroom removes N messages from the front, drop only those message items
//      and preserve all function_call / function_call_output items in place.
async function compressInputBody(body, model, compress) {
  const input = body.input;
  const cacheFloor = findCacheFloor(input);

  const headItems = input.slice(0, cacheFloor + 1);
  const tailItems = input.slice(cacheFloor + 1);

  // Build a Chat Completions messages array from the message items in the tail.
  const msgIndices = []; // positions inside tailItems
  const messages = [];
  for (let i = 0; i < tailItems.length; i++) {
    const item = tailItems[i];
    const role = item?.role;
    if (item?.type === "message" && (role === "user" || role === "assistant" || role === "developer")) {
      const text = Array.isArray(item.content)
        ? item.content.map(c => c.text || c.input_text || c.output_text || "").filter(Boolean).join("")
        : (typeof item.content === "string" ? item.content : "");
      if (text) {
        msgIndices.push(i);
        messages.push({ role: role === "developer" ? "system" : role, content: text });
      }
    }
  }

  if (messages.length < 1) return null;

  try {
    const r = await compressTail(cloneForCompress(messages), model, compress);
    if (!r || r.saved <= 0) return null;

    const removedCount = messages.length - r.compressed.length;
    const newTail = [];
    const removedTailMsgIndices = removedCount > 0
      ? new Set(msgIndices.slice(0, removedCount))
      : null;
    const msgIndexSet = new Set(msgIndices);
    let compressedIdx = 0;

    for (let i = 0; i < tailItems.length; i++) {
      if (removedTailMsgIndices?.has(i)) continue;

      const item = tailItems[i];
      if (!msgIndexSet.has(i)) {
        newTail.push(item);
        continue;
      }

      const compressedMsg = r.compressed[compressedIdx++];
      newTail.push(compressedMsg ? applyCompressedTextToInputItem(item, compressedMsg) : item);
    }

    if (compressedIdx !== r.compressed.length) {
      console.warn("[HEADROOM] compressInputBody: compressed message mapping mismatch, skipping");
      return null;
    }

    body.input = [...headItems, ...newTail];
    return { before: r.before, after: r.after, saved: r.saved };
  } catch (err) {
    console.warn("[HEADROOM] compressInputBody failed:", err?.message || err);
    invalidateProbe();
    return null;
  }
}

/**
 * Compress conversation history via headroom proxy.
 * Handles both Chat Completions (body.messages) and Responses API (body.input) formats.
 * Only content AFTER the last cache_control boundary is sent to headroom —
 * the cached prefix is left byte-identical so KV cache entries are not invalidated.
 * Returns { before, after, saved } on success, null if skipped/unavailable.
 */
export async function compressWithHeadroom(body, model) {
  const hasMessages = Array.isArray(body.messages) && body.messages.length >= 2;
  const hasInput = Array.isArray(body.input) && body.input.length >= 2;
  if (!hasMessages && !hasInput) return null;

  // Hard skip before probing service (Req 8.3): empty tail or system-only tail
  if (hasMessages && shouldSkipHeadroomForMessages(body.messages)) return null;
  if (hasInput && shouldSkipHeadroomForInput(body.input)) return null;

  const compress = await loadCompress();
  if (!compress) return null;
  if (!(await probeProxy())) return null;

  return hasMessages
    ? compressMessagesBody(body, model, compress)
    : compressInputBody(body, model, compress);
}

export async function getHeadroomStatus() {
  const baseUrl = resolveHeadroomBaseUrl();
  const cloud = isHeadroomCloudConfigured();
  const installed = !!(await loadCompress());
  const reachable = cloud ? true : (installed ? await probeProxy(baseUrl) : false);
  return {
    installed,
    reachable,
    cloud,
    proxyUrl: baseUrl,
    localCliRequired: !cloud,
  };
}

/**
 * Live metrics from the Headroom proxy /stats endpoint (dashboard + MCP compressions).
 * Returns null when the proxy is unreachable or stats cannot be fetched.
 */
export async function getHeadroomProxyStats(baseUrl = resolveHeadroomBaseUrl()) {
  const cloud = isHeadroomCloudConfigured();
  if (!cloud && !(await probeProxy(baseUrl))) return null;

  try {
    const res = await proxyAwareFetch(`${baseUrl.replace(/\/+$/, "")}/stats?cached=1`, {
      signal: AbortSignal.timeout(2000),
      cache: "no-store",
    }, null);
    if (!res.ok) return null;
    const data = await res.json();
    return normalizeHeadroomProxyStats(data, baseUrl);
  } catch {
    return null;
  }
}

function normalizeHeadroomProxyStats(data, baseUrl) {
  const root = data && typeof data === "object" ? data : {};
  const summary = root.summary && typeof root.summary === "object" ? root.summary : {};
  const tokens = root.tokens && typeof root.tokens === "object" ? root.tokens : {};
  const requests = root.requests && typeof root.requests === "object" ? root.requests : {};
  const cost = root.cost && typeof root.cost === "object" ? root.cost : {};
  const summaryCost = summary.cost && typeof summary.cost === "object" ? summary.cost : {};
  const mcp = summary.mcp && typeof summary.mcp === "object" ? summary.mcp : {};
  const compression = summary.compression && typeof summary.compression === "object"
    ? summary.compression
    : {};

  const proxyUrl = baseUrl.replace(/\/+$/, "");
  return {
    dashboardUrl: `${proxyUrl}/dashboard`,
    requestsTotal: Number(requests.total) || 0,
    tokensSaved: Number(tokens.saved) || 0,
    proxyCompressionSaved: Number(tokens.proxy_compression_saved) || 0,
    mcpCompressions: Number(mcp.compressions) || 0,
    mcpTokensRemoved: Number(mcp.tokens_removed) || 0,
    compressionRequests: Number(compression.requests_compressed) || 0,
    costSavingsUsd: Number(cost.savings_usd ?? cost.total_saved_usd ?? summaryCost.total_saved_usd) || 0,
  };
}
