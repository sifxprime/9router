// Minimal capabilities shim — ported from upstream decolua/9router 5e5e78d
// (subset needed for "show custom vision models in selector" feature)
// Full Wave-2 capabilities.js with PATTERNS, DEFAULT_CAPABILITIES, exact-id overrides
// is deferred — only the service-kind → runtime-capability mapping is needed here.

// User-added model metadata can carry dashboard service kinds instead of the
// runtime capability names used in upstream Wave-2 PATTERNS. Map those typed
// model kinds into input / output capabilities so custom vision models are not
// treated as text-only by the chat selector.
const SERVICE_KIND_CAPABILITIES = {
  imageToText: { vision: true },
  image: { imageOutput: true },
  stt: { audioInput: true },
  tts: { audioOutput: true },
  embedding: { tools: false },
};

export function capabilitiesFromServiceKind(kind) {
  return SERVICE_KIND_CAPABILITIES[kind] || null;
}

// Permissive default-capability lookup used by the Fusion combo strategy.
// The Wave-2 PATTERNS-based table is deferred; until merged, treat every
// chat-style model as supporting tools + text. Judges scored by this stub
// never reject a candidate on missing capabilities — which is the safe
// fallback (a real judge mismatch will surface as a runtime error, not a
// silent filtered-out condition).
const DEFAULT_RUNTIME_CAPABILITIES = {
  tools: true,
  vision: false,
  audioInput: false,
  audioOutput: false,
  imageOutput: false,
  reasoning: true,
  cache: false,
  search: false,
  fetch: false,
};

export function getCapabilitiesForModel(_provider, _model) {
  return { ...DEFAULT_RUNTIME_CAPABILITIES };
}
