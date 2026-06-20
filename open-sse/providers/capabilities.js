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

// Permissive default-capability lookup used by Fusion + capacity auto-switch.
// The full upstream Wave-2 PATTERNS-based table (269 lines, ~40 patterns) is
// deferred. We use a small pragmatic pattern table here that covers the
// modalities that matter most for combo reordering: vision + pdf.
const DEFAULT_RUNTIME_CAPABILITIES = {
  tools: true,
  vision: false,
  pdf: false,
  audioInput: false,
  audioOutput: false,
  videoInput: false,
  imageOutput: false,
  reasoning: true,
  cache: false,
  search: false,
  fetch: false,
};

// Pattern matchers (first match wins, ordered specific → generic).
// IDs are lower-cased before matching. Sourced from each vendor's docs +
// models.dev manifest cross-check. Updated 2026-06-21.
const VISION_PATTERNS = [
  // OpenAI
  /^gpt-4\.5(-|$)/, /^gpt-4\.6(-|$)/, /^gpt-4o/, /^gpt-5/, /^o3/, /^o4-mini/,
  // Anthropic
  /^claude-3(-|$)/, /^claude-3\./, /^claude-opus-4/, /^claude-sonnet-4/, /^claude-haiku-4/,
  // Google (gemini-pro / gemini-pro-agent / etc. are Antigravity routing aliases for 1.5+ Pro)
  /^gemini-1\.5/, /^gemini-2/, /^gemini-3/, /^gemini-pro/, /^gemini-flash/, /^gemma-3/,
  // xAI
  /^grok-vision/, /^grok-2/, /^grok-3/, /^grok-4/,
  // Meta + open models
  /^llama-3\.2-(11|90)b-vision/, /^llama-4/, /^pixtral/, /^qwen-?2?-?vl/, /^qwen3-vl/, /^qwen3\.\d+-vl/,
  // Generic safety net
  /vision/, /-vl(-|$)/, /multimodal/,
];

const PDF_PATTERNS = [
  // Anthropic native PDF support (Claude 3+ via document blocks)
  /^claude-3(-|$)/, /^claude-3\./, /^claude-opus-4/, /^claude-sonnet-4/, /^claude-haiku-4/,
  // Google Gemini native PDF (incl. Antigravity routing aliases)
  /^gemini-1\.5/, /^gemini-2/, /^gemini-3/, /^gemini-pro/, /^gemini-flash/,
];

function matchAny(patterns, id) {
  for (const re of patterns) {
    if (re.test(id)) return true;
  }
  return false;
}

export function getCapabilitiesForModel(_provider, model) {
  const caps = { ...DEFAULT_RUNTIME_CAPABILITIES };
  if (typeof model !== "string" || !model) return caps;
  const id = model.toLowerCase();
  if (matchAny(VISION_PATTERNS, id)) caps.vision = true;
  if (matchAny(PDF_PATTERNS, id)) caps.pdf = true;
  return caps;
}
