import { v4 as uuidv4 } from "uuid";
import { createHash } from "crypto";

export const DEFAULT_KIRO_REGION = "us-east-1";

const KIRO_RUNTIME_SDK_VERSION = "1.0.0";
const KIRO_AGENT_OS = "windows";
const KIRO_AGENT_OS_VERSION = "10.0.26200";
const KIRO_NODE_VERSION = "22.21.1";
const KIRO_VERSION = "0.10.32";

/**
 * Extract region from a profileArn like
 *   arn:aws:codewhisperer:us-east-1:123456789012:profile/ABC
 */
export function regionFromProfileArn(profileArn) {
  if (!profileArn || typeof profileArn !== "string") return DEFAULT_KIRO_REGION;
  const parts = profileArn.split(":");
  if (parts.length >= 4 && parts[3]) return parts[3];
  return DEFAULT_KIRO_REGION;
}

export function resolveKiroRegion(credentialsOrPsd) {
  const psd = credentialsOrPsd?.providerSpecificData || credentialsOrPsd || {};
  if (psd.region && typeof psd.region === "string") return psd.region;
  return regionFromProfileArn(psd.profileArn);
}

export function buildKiroChatUrl(credentials) {
  const region = resolveKiroRegion(credentials);
  return `https://codewhisperer.${region}.amazonaws.com/generateAssistantResponse`;
}

export function buildKiroListModelsUrl(credentials, profileArn) {
  const arn = profileArn || credentials?.providerSpecificData?.profileArn || "";
  const region = regionFromProfileArn(arn);
  const params = new URLSearchParams();
  params.set("origin", "AI_EDITOR");
  if (arn) params.set("profileArn", arn);
  return `https://q.${region}.amazonaws.com/ListAvailableModels?${params.toString()}`;
}

export function buildKiroSocialAuthRefreshUrl(region) {
  const r = region || DEFAULT_KIRO_REGION;
  return `https://prod.${r}.auth.desktop.kiro.dev/refreshToken`;
}

/**
 * Per-account fingerprint headers Kiro upstream validates.
 * @param {object} [options]
 * @param {string} [options.accept] - Optional Accept header override
 */
export function buildKiroFingerprintHeaders(credentials, options = {}) {
  const seed =
    credentials?.providerSpecificData?.clientId
    || credentials?.refreshToken
    || credentials?.providerSpecificData?.profileArn
    || credentials?.accessToken
    || "kiro-anonymous";
  const machineId = createHash("sha256").update(String(seed)).digest("hex");

  const userAgent =
    `aws-sdk-js/${KIRO_RUNTIME_SDK_VERSION} ua/2.1 ` +
    `os/${KIRO_AGENT_OS}#${KIRO_AGENT_OS_VERSION} ` +
    `lang/js md/nodejs#${KIRO_NODE_VERSION} ` +
    `api/codewhispererruntime#${KIRO_RUNTIME_SDK_VERSION} m/N,E ` +
    `KiroIDE-${KIRO_VERSION}-${machineId}`;
  const amzUserAgent = `aws-sdk-js/${KIRO_RUNTIME_SDK_VERSION} KiroIDE-${KIRO_VERSION}-${machineId}`;

  const headers = {
    "User-Agent": userAgent,
    "x-amz-user-agent": amzUserAgent,
    "x-amzn-kiro-agent-mode": "vibe",
    "x-amzn-codewhisperer-optout": "true",
    "amz-sdk-request": "attempt=1; max=1",
    "amz-sdk-invocation-id": uuidv4(),
  };

  if (options.accept) {
    headers.Accept = options.accept;
  }

  return headers;
}
