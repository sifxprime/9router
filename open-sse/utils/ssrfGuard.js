import dns from "node:dns";
import { promisify } from "node:util";
import {
  LOOPBACK_HOSTNAMES,
  isBlockedHostname,
  assertSafeFetchUrl,
  isSafeFetchUrl,
  validateProviderBaseUrl,
} from "./ssrfGuardCore.js";

// Re-export the sync primitives so existing `ssrfGuard.js` importers keep working.
// The sync core has NO node: imports (browser-safe); the DNS guards below add
// node:dns resolution and must only be imported from server code.
export {
  LOOPBACK_HOSTNAMES,
  isBlockedHostname,
  assertSafeFetchUrl,
  isSafeFetchUrl,
  validateProviderBaseUrl,
};

const resolve4 = promisify(dns.resolve4);
const resolve6 = promisify(dns.resolve6);

const DNS_RESOLVE_CACHE = new Map();
const DNS_RESOLVE_CACHE_TTL_MS = 60_000;

function isIpv4Literal(host) {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) >= 0 && Number(p) <= 255);
}

/**
 * Reject hostnames that resolve to private/reserved addresses (DNS rebinding guard).
 * @throws {Error} when resolution fails or any address is blocked
 */
export async function assertSafeResolvedHostname(hostname, options = {}) {
  const { allowLoopback = false } = options;
  const h = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!h) throw new Error("URL host is not allowed");

  if (allowLoopback && LOOPBACK_HOSTNAMES.has(h)) return;

  if (isIpv4Literal(h) || h.includes(":")) {
    if (isBlockedHostname(h)) throw new Error("URL host is not allowed");
    return;
  }

  const cached = DNS_RESOLVE_CACHE.get(h);
  let addresses;
  if (cached && Date.now() < cached.expiry) {
    addresses = cached.addresses;
  } else {
    addresses = [];
    try {
      addresses.push(...await resolve4(h));
    } catch (err) {
      if (err?.code !== "ENOTFOUND" && err?.code !== "ENODATA") throw err;
    }
    try {
      addresses.push(...await resolve6(h));
    } catch (err) {
      if (addresses.length === 0 && err?.code !== "ENOTFOUND" && err?.code !== "ENODATA") throw err;
    }

    if (addresses.length === 0) throw new Error("DNS resolution failed");
    DNS_RESOLVE_CACHE.set(h, { addresses, expiry: Date.now() + DNS_RESOLVE_CACHE_TTL_MS });
  }

  const safe = addresses.every((ip) => {
    if (allowLoopback && LOOPBACK_HOSTNAMES.has(ip.toLowerCase())) return true;
    return !isBlockedHostname(ip);
  });
  if (!safe) throw new Error("URL host resolves to a blocked address");
}

/** Validate URL hostname literals and resolved addresses. */
export async function assertSafeFetchUrlWithDns(urlString, options = {}) {
  const parsed = assertSafeFetchUrl(urlString, options);
  await assertSafeResolvedHostname(parsed.hostname, options);
  return parsed;
}

/** Normalize and validate a provider base URL including DNS resolution checks. */
export async function validateProviderBaseUrlWithDns(baseUrl, options = {}) {
  const normalized = String(baseUrl || "").trim().replace(/\/$/, "");
  await assertSafeFetchUrlWithDns(normalized, options);
  return normalized;
}
