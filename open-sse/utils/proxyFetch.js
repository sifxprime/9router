import { Readable } from "stream";
import { createRequire } from "module";
import { MEMORY_CONFIG } from "../config/runtimeConfig.js";
import { dbg } from "./debugLog.js";
import { assertSafeResolvedHostname } from "./ssrfGuard.js";

const require = createRequire(import.meta.url);
const { isKiroMitmHost } = require("../../src/shared/constants/mitmToolHosts.js");

const originalFetch = globalThis.fetch;
const proxyDispatchers = new Map();
const SUPPORTED_PROXY_PROTOCOLS = new Set(["http:", "https:"]);
const MAX_UPSTREAM_REDIRECTS = 5;

// ─── TLS fingerprinting via got-scraping (browser-like JA3) ───────────────
// Disabled: not in use. Kept commented for future re-enable.
// Restore the original block to re-enable per-host JA3 spoofing.
/*
let _gotScraping = null;
let _gotScrapingChecked = false;
const _gotScrapingLoggedHosts = new Set();

async function getGotScraping() {
  if (_gotScrapingChecked) return _gotScraping;
  _gotScrapingChecked = true;
  try {
    const mod = await import("got-scraping");
    _gotScraping = typeof mod.gotScraping === "function" ? mod.gotScraping : null;
    if (_gotScraping) dbg("TLS", "got-scraping loaded (browser-like JA3 enabled)");
  } catch (e) {
    console.warn(`[ProxyFetch] got-scraping unavailable, falling back to native fetch: ${e.message}`);
    _gotScraping = null;
  }
  return _gotScraping;
}

async function gotScrapingFetch(url, options) {
  const gs = await getGotScraping();
  if (!gs) return null;

  const method = (options.method || "GET").toUpperCase();
  const headersInit = options.headers || {};
  const headers = headersInit instanceof Headers
    ? Object.fromEntries(headersInit.entries())
    : { ...headersInit };

  return new Promise((resolve, reject) => {
    let settled = false;
    const stream = gs.stream({
      url,
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? undefined : options.body,
      throwHttpErrors: false,
      retry: { limit: 0 },
      timeout: { request: undefined },
      followRedirect: false,
      decompress: true,
    });

    if (options.signal) {
      const onAbort = () => { try { stream.destroy(new Error("aborted")); } catch { } };
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }

    stream.once("response", (res) => {
      if (settled) return;
      settled = true;
      const resHeaders = new Headers();
      for (const [k, v] of Object.entries(res.headers || {})) {
        if (Array.isArray(v)) v.forEach((x) => resHeaders.append(k, String(x)));
        else if (v != null) resHeaders.set(k, String(v));
      }
      const body = Readable.toWeb(stream);
      resolve(new Response(body, { status: res.statusCode, statusText: res.statusMessage || "", headers: resHeaders }));
    });

    stream.once("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

async function tryGotScrapingFetch(url, options) {
  try {
    const res = await gotScrapingFetch(url, options);
    if (res) {
      try {
        const host = new URL(typeof url === "string" ? url : url.toString()).hostname;
        if (!_gotScrapingLoggedHosts.has(host)) {
          _gotScrapingLoggedHosts.add(host);
          dbg("TLS", `using got-scraping for ${host}`);
        }
      } catch { }
    }
    return res;
  } catch (e) {
    console.warn(`[ProxyFetch] got-scraping request failed, fallback to native fetch: ${e.message}`);
    return null;
  }
}
*/

// DNS cache — use Map to avoid prototype pollution via malformed hostnames
const DNS_CACHE = new Map();
const MITM_BYPASS_HOSTS = [
  "cloudcode-pa.googleapis.com",
  "daily-cloudcode-pa.googleapis.com",
  "api.individual.githubcopilot.com",
  "q.us-east-1.amazonaws.com",
  "codewhisperer.us-east-1.amazonaws.com",
  "api2.cursor.sh",
];
const GOOGLE_DNS_SERVERS = ["8.8.8.8", "8.8.4.4"];
const HTTPS_PORT = 443;
const HTTP_SUCCESS_MIN = 200;
const HTTP_SUCCESS_MAX = 300;

function normalizeString(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

/**
 * Resolve real IP using Google DNS (bypass system DNS)
 */
async function resolveRealIP(hostname) {
  const cached = DNS_CACHE.get(hostname);
  if (cached && Date.now() < cached.expiry) return cached.ip;

  try {
    const dns = await import("dns");
    const { promisify } = await import("util");
    const resolver = new dns.Resolver();
    resolver.setServers(GOOGLE_DNS_SERVERS);
    const resolve4 = promisify(resolver.resolve4.bind(resolver));
    const addresses = await resolve4(hostname);
    DNS_CACHE.set(hostname, { ip: addresses[0], expiry: Date.now() + MEMORY_CONFIG.dnsCacheTtlMs });
    return addresses[0];
  } catch (error) {
    console.warn(`[ProxyFetch] DNS resolve failed for ${hostname}:`, error.message);
    return null;
  }
}

/**
 * Check if request should bypass MITM DNS redirect
 */
function hostnameMatchesMitmBypass(hostname, bypassHost) {
  const host = hostname.toLowerCase();
  const pattern = bypassHost.toLowerCase();
  return host === pattern || host.endsWith(`.${pattern}`);
}

function shouldBypassMitmDns(url) {
  try {
    const hostname = new URL(url).hostname;
    if (isKiroMitmHost(hostname)) return true;
    return MITM_BYPASS_HOSTS.some((host) => hostnameMatchesMitmBypass(hostname, host));
  } catch { return false; }
}

function serializeBypassRequestBody(body) {
  if (body == null) return undefined;
  if (typeof body === "string") return body;
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (typeof body === "object" && typeof body.pipe === "function") {
    throw new Error("[ProxyFetch] Streaming request bodies are not supported on MITM bypass path");
  }
  return JSON.stringify(body);
}

function shouldBypassByNoProxy(targetUrl, noProxyValue) {
  const noProxy = normalizeString(noProxyValue);
  if (!noProxy) return false;

  let hostname;
  try { hostname = new URL(targetUrl).hostname.toLowerCase(); } catch { return false; }
  const patterns = noProxy.split(",").map((p) => p.trim().toLowerCase()).filter(Boolean);

  return patterns.some((pattern) => {
    if (pattern === "*") return true;
    if (pattern.startsWith(".")) return hostname.endsWith(pattern) || hostname === pattern.slice(1);
    return hostname === pattern || hostname.endsWith(`.${pattern}`);
  });
}

/**
 * Get proxy URL from environment
 */
function getEnvProxyUrl(targetUrl) {
  const noProxy = process.env.NO_PROXY || process.env.no_proxy;
  if (shouldBypassByNoProxy(targetUrl, noProxy)) return null;

  let protocol;
  try { protocol = new URL(targetUrl).protocol; } catch { return null; }

  if (protocol === "https:") {
    return process.env.HTTPS_PROXY || process.env.https_proxy ||
      process.env.ALL_PROXY || process.env.all_proxy;
  }

  return process.env.HTTP_PROXY || process.env.http_proxy ||
    process.env.ALL_PROXY || process.env.all_proxy;
}

/**
 * Normalize proxy URL (allow host:port)
 */
function normalizeProxyUrl(proxyUrl, throwOnError = true) {
  const normalizedInput = normalizeString(proxyUrl);
  if (!normalizedInput) return null;

  try {
    const withProtocol = /^[a-z][a-z\d+\-.]*:\/\//i.test(normalizedInput)
      ? normalizedInput
      : `http://${normalizedInput}`;
    const parsed = new URL(withProtocol);
    if (!SUPPORTED_PROXY_PROTOCOLS.has(parsed.protocol)) {
      throw new Error("Proxy URL must use http or https");
    }
    if (!parsed.hostname) {
      throw new Error("Proxy URL host is required");
    }
    const normalized = parsed.toString();
    return parsed.pathname === "/" && !parsed.search && !parsed.hash
      ? normalized.replace(/\/$/, "")
      : normalized;
  } catch (error) {
    if (throwOnError) throw error;
    return null;
  }
}

function normalizeRuntimeProxyUrl(proxyUrl, source) {
  if (!normalizeString(proxyUrl)) return null;
  const normalized = normalizeProxyUrl(proxyUrl, false);
  if (!normalized) {
    console.warn(`[ProxyFetch] Ignoring invalid ${source} proxy URL`);
  }
  return normalized;
}

function resolveConnectionProxyUrl(targetUrl, proxyOptions) {
  const enabled = proxyOptions?.enabled === true || proxyOptions?.connectionProxyEnabled === true;
  if (!enabled) return null;

  const proxyUrlRaw = normalizeString(proxyOptions?.url ?? proxyOptions?.connectionProxyUrl);
  if (!proxyUrlRaw) return null;

  const noProxy = normalizeString(proxyOptions?.noProxy ?? proxyOptions?.connectionNoProxy);
  if (noProxy && shouldBypassByNoProxy(targetUrl, noProxy)) return null;

  const normalizedProxyUrl = normalizeProxyUrl(proxyUrlRaw, false);
  if (!normalizedProxyUrl) {
    if (proxyOptions?.strictProxy === true) {
      throw new Error("[ProxyFetch] Strict connection proxy URL is invalid");
    }
    console.warn("[ProxyFetch] Ignoring invalid connection proxy URL");
  }
  return normalizedProxyUrl;
}

/**
 * Create proxy dispatcher lazily (undici-compatible)
 */
async function getDispatcher(proxyUrl) {
  const normalized = normalizeProxyUrl(proxyUrl);
  if (!normalized) return null;

  if (!proxyDispatchers.has(normalized)) {
    // Evict oldest entry if max size reached
    if (proxyDispatchers.size >= MEMORY_CONFIG.proxyDispatchersMaxSize) {
      proxyDispatchers.delete(proxyDispatchers.keys().next().value);
    }
    const { ProxyAgent } = await import("undici");
    proxyDispatchers.set(normalized, new ProxyAgent({ uri: normalized }));
  }

  return proxyDispatchers.get(normalized);
}

/**
 * Create HTTPS request with manual socket connection (bypass DNS)
 */
async function createBypassRequest(parsedUrl, realIP, options) {
  const httpsModule = await import("https");
  const netModule = await import("net");
  // CJS modules expose exports via .default in ESM dynamic import context
  const https = httpsModule.default ?? httpsModule;
  const net = netModule.default ?? netModule;

  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let req = null;
    let settled = false;
    let activeRes = null;

    const cleanup = () => {
      try { req?.destroy(); } catch { /* noop */ }
      try { activeRes?.destroy(); } catch { /* noop */ }
      try { socket.destroy(); } catch { /* noop */ }
    };

    const fail = (err) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", onAbort);
      cleanup();
      reject(err);
    };

    const onAbort = () => {
      if (settled) {
        cleanup();
        return;
      }
      fail(options.signal?.reason || new Error("aborted"));
    };

    if (options.signal) {
      if (options.signal.aborted) {
        fail(options.signal.reason || new Error("aborted"));
        return;
      }
      options.signal.addEventListener("abort", onAbort);
    }

    socket.connect(HTTPS_PORT, realIP, () => {
      const reqOptions = {
        socket,
        // SNI + cert hostname are validated against the hostname the caller
        // asked for, not the IP we connected to. This keeps the DNS-bypass
        // (avoiding /etc/hosts MITM) while still rejecting on-path attackers
        // that present a different cert. The MITM_BYPASS_HOSTS targets are
        // all public-CA-issued (Google / GitHub / AWS / Cursor) so default
        // verification works without any extra trust store.
        servername: parsedUrl.hostname,
        path: parsedUrl.pathname + parsedUrl.search,
        method: options.method || "POST",
        headers: {
          ...options.headers,
          Host: parsedUrl.hostname,
        },
      };

      req = https.request(reqOptions, (res) => {
        if (settled) return;
        settled = true;
        options.signal?.removeEventListener("abort", onAbort);
        activeRes = res;
        const response = {
          ok: res.statusCode >= HTTP_SUCCESS_MIN && res.statusCode < HTTP_SUCCESS_MAX,
          status: res.statusCode,
          statusText: res.statusMessage,
          headers: new Map(Object.entries(res.headers)),
          body: Readable.toWeb(res),
          text: async () => {
            const chunks = [];
            for await (const chunk of res) chunks.push(chunk);
            return Buffer.concat(chunks).toString();
          },
          // Cursor executor (and any binary-response caller on the MITM-bypass path)
          // expects a fetch-like arrayBuffer(). Without it: "f.arrayBuffer is not a
          // function". text()/body/arrayBuffer are mutually-exclusive consumers of res.
          arrayBuffer: async () => {
            const chunks = [];
            for await (const chunk of res) chunks.push(chunk);
            const buf = Buffer.concat(chunks);
            return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
          },
          json: async () => JSON.parse(await response.text()),
        };
        resolve(response);
      });

      req.on("error", fail);
      if (options.body != null) {
        req.write(serializeBypassRequestBody(options.body));
      }
      req.end();
    });

    socket.on("error", fail);
  });
}

// Bound the time-to-first-byte (connect → response headers) of an upstream call.
// Without this a stalled upstream hangs the request forever, surfacing as the
// client's own "API timeout" (e.g. Claude Code) instead of a clean 5xx here.
// Cleared the moment headers arrive, so it never aborts a long-running stream body.
const DEFAULT_UPSTREAM_TIMEOUT_MS = 120000; // 2 min to first byte

function withUpstreamTimeout(options) {
  const ms = Number(options.timeoutMs ?? process.env.UPSTREAM_TIMEOUT_MS ?? DEFAULT_UPSTREAM_TIMEOUT_MS);
  if (!Number.isFinite(ms) || ms <= 0 || typeof AbortSignal?.any !== "function") {
    return { fetchOptions: options, done: () => {} };
  }
  const tc = new AbortController();
  const timer = setTimeout(
    () => tc.abort(new DOMException(`Upstream timeout: no response headers after ${ms}ms`, "TimeoutError")),
    ms
  );
  if (typeof timer.unref === "function") timer.unref();
  const signal = options.signal ? AbortSignal.any([options.signal, tc.signal]) : tc.signal;
  return { fetchOptions: { ...options, signal }, done: () => clearTimeout(timer) };
}

/**
 * Fetch that follows redirects manually, re-validating each hop's hostname
 * against the SSRF guard. Without this, a validated initial host can 30x-redirect
 * to a private/metadata address (e.g. 169.254.169.254) and the default
 * redirect:"follow" would chase it, defeating assertSafeResolvedHostname.
 */
async function safeRedirectFetch(url, options, fetchImpl) {
  let currentUrl = typeof url === "string" ? url : url.toString();
  let currentOptions = { ...options, redirect: "manual" };

  for (let hop = 0; hop <= MAX_UPSTREAM_REDIRECTS; hop++) {
    const res = await fetchImpl(currentUrl, currentOptions);
    // Only 3xx is a redirect; anything else (incl. undefined status from
    // non-standard Response-likes) is handed back untouched.
    const status = Number(res?.status);
    if (!(status >= 300 && status < 400)) return res;

    const location = res.headers?.get?.("location");
    if (!location) return res; // 3xx without Location — hand back as-is

    let nextUrl;
    try {
      nextUrl = new URL(location, currentUrl).toString();
    } catch {
      throw new Error("[ProxyFetch] Redirect to invalid URL blocked");
    }

    const nextHost = new URL(nextUrl).hostname;
    const allowLoopback = ["localhost", "127.0.0.1", "::1"].includes(nextHost.toLowerCase());
    try {
      await assertSafeResolvedHostname(nextHost, { allowLoopback });
    } catch (dnsError) {
      throw new Error(`[ProxyFetch] Redirect blocked by SSRF guard: ${dnsError.message}`);
    }

    // Drain the redirect response body to free the socket before re-issuing.
    try { await res.body?.cancel(); } catch { /* noop */ }

    // Per fetch spec, 303 (and 301/302 for non-GET/HEAD) downgrade to GET and drop the body.
    const method = (currentOptions.method || "GET").toUpperCase();
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && method !== "GET" && method !== "HEAD")) {
      const { body, ...rest } = currentOptions;
      currentOptions = { ...rest, method: "GET" };
    }
    currentUrl = nextUrl;
  }

  throw new Error(`[ProxyFetch] Too many redirects (>${MAX_UPSTREAM_REDIRECTS})`);
}

export async function proxyAwareFetch(url, options = {}, proxyOptions = null) {
  const { fetchOptions, done } = withUpstreamTimeout(options);
  try {
    return await _proxyAwareFetch(url, fetchOptions, proxyOptions);
  } finally {
    done(); // clear the TTFB timer once headers resolve (or on error) — stream body is unbounded
  }
}

async function _proxyAwareFetch(url, options = {}, proxyOptions = null) {
  const targetUrl = typeof url === "string" ? url : url.toString();

  if (!shouldBypassMitmDns(targetUrl)) {
    try {
      const hostname = new URL(targetUrl).hostname;
      const allowLoopback = ["localhost", "127.0.0.1", "::1"].includes(hostname.toLowerCase());
      await assertSafeResolvedHostname(hostname, { allowLoopback });
    } catch (dnsError) {
      throw new Error(`[ProxyFetch] DNS safety check failed: ${dnsError.message}`);
    }
  }

  const connectionProxyUrl = resolveConnectionProxyUrl(targetUrl, proxyOptions);
  const envProxyUrl = connectionProxyUrl ? null : normalizeRuntimeProxyUrl(getEnvProxyUrl(targetUrl), "environment");
  let proxyUrl = connectionProxyUrl || envProxyUrl;

  // Vercel relay is lower precedence than per-connection proxy (AGENTS.md § outbound proxy routing)
  const vercelRelayUrl = !connectionProxyUrl ? normalizeString(proxyOptions?.vercelRelayUrl) : null;
  if (!proxyUrl && vercelRelayUrl) {
    const parsed = new URL(targetUrl);
    const relayHeaders = {
      ...options.headers,
      "x-relay-target": `${parsed.protocol}//${parsed.host}`,
      "x-relay-path": `${parsed.pathname}${parsed.search}`,
    };
    const relayAuthSecret = normalizeString(proxyOptions?.relayAuthSecret);
    if (relayAuthSecret) relayHeaders["x-relay-auth"] = relayAuthSecret;
    return originalFetch(vercelRelayUrl, { ...options, headers: relayHeaders });
  }

  // MITM DNS bypass: for known MITM-intercepted hosts, resolve real IP to avoid DNS spoof
  if (shouldBypassMitmDns(targetUrl)) {
    const parsedUrl = new URL(targetUrl);
    if (proxyUrl) {
      // Proxy resolves DNS externally (not affected by /etc/hosts) — use proxy directly
      try {
        const dispatcher = await getDispatcher(proxyUrl);
        return await originalFetch(url, { ...options, dispatcher });
      } catch (proxyError) {
        if (proxyOptions?.strictProxy === true || connectionProxyUrl) {
          throw new Error(`[ProxyFetch] Proxy required but failed: ${proxyError.message}`);
        }
        console.warn(`[ProxyFetch] Proxy failed, falling back to direct bypass: ${proxyError.message}`);
      }
    }
    // No proxy (or proxy failed) — external DNS + direct socket; never fall back to system DNS
    const realIP = await resolveRealIP(parsedUrl.hostname);
    if (!realIP) {
      throw new Error(`[ProxyFetch] External DNS resolution failed for MITM bypass host: ${parsedUrl.hostname}`);
    }
    return await createBypassRequest(parsedUrl, realIP, options);
  }

  if (proxyUrl) {
    try {
      const dispatcher = await getDispatcher(proxyUrl);
      return await safeRedirectFetch(url, options, (u, o) => originalFetch(u, { ...o, dispatcher }));
    } catch (proxyError) {
      // Configured proxy (per-connection or environment) must not silently fall back to direct
      if (proxyOptions?.strictProxy !== false) {
        throw new Error(`[ProxyFetch] Proxy required but failed: ${proxyError.message}`);
      }
      console.warn(`[ProxyFetch] Proxy failed, falling back to direct (strictProxy=false): ${proxyError.message}`);
      return safeRedirectFetch(url, options, originalFetch);
    }
  }

  // got-scraping disabled — use native fetch directly
  // (Re-enable per-host by wrapping with tryGotScrapingFetch when needed)
  return safeRedirectFetch(url, options, originalFetch);
}

/**
 * Patched global fetch with env-proxy support and MITM DNS bypass
 */
async function patchedFetch(url, options = {}) {
  return proxyAwareFetch(url, options, null);
}

// Idempotency guard — only patch once to avoid wrapping multiple times
if (globalThis.fetch !== patchedFetch) {
  globalThis.fetch = patchedFetch;
}

export default patchedFetch;

/**
 * Build proxy routing options from a connection credentials record (same shape as chatCore).
 */
export function buildProxyOptionsFromCredentials(credentials) {
  const psd = credentials?.providerSpecificData || {};
  return {
    connectionProxyEnabled: psd.connectionProxyEnabled === true,
    connectionProxyUrl: psd.connectionProxyUrl || "",
    connectionNoProxy: psd.connectionNoProxy || "",
    vercelRelayUrl: psd.vercelRelayUrl || "",
    relayAuthSecret: psd.relayAuthSecret || "",
    strictProxy: psd.strictProxy === true,
  };
}

export {
  resolveConnectionProxyUrl,
  getEnvProxyUrl,
  shouldBypassMitmDns,
  shouldBypassByNoProxy,
  normalizeProxyUrl,
  resolveRealIP,
  MITM_BYPASS_HOSTS,
};
