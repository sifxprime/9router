// Catalog of every recognized env var. Lists name, category, description, default
// (display-friendly), and whether the value should be redacted on the dashboard.
// Anything not in this catalog still shows up in the panel as "uncatalogued" so
// users can see what's set in their environment but not officially documented.

export const ENV_VAR_CATALOG = [
  // --- App config ---
  { name: "PORT", category: "app", desc: "Dashboard + API port", default: "20128", secret: false },
  { name: "HOSTNAME", category: "app", desc: "Bind host (0.0.0.0 binds to all interfaces, LAN-exposed)", default: "0.0.0.0", secret: false },
  { name: "NODE_ENV", category: "app", desc: "Runtime mode (production / development)", default: "(framework)", secret: false },
  { name: "DATA_DIR", category: "app", desc: "Main app data location (SQLite + machine-id + MITM cert)", default: "~/.krouter", secret: false },
  { name: "BASE_URL", category: "app", desc: "Server-side internal base URL for cloud sync jobs", default: "http://localhost:20128", secret: false },
  { name: "CLOUD_URL", category: "app", desc: "Server-side cloud sync endpoint", default: "https://9router.com", secret: false },
  { name: "TRAY_MODE", category: "app", desc: "Set internally when launched in system tray mode", default: "(unset)", secret: false },

  // --- Security ---
  { name: "INITIAL_PASSWORD", category: "security", desc: "First-login password when no hash exists yet", default: "123456", secret: true },
  { name: "JWT_SECRET", category: "security", desc: "JWT signing secret for dashboard auth cookie", default: "auto-generated (~/.krouter/jwt-secret)", secret: true },
  { name: "MACHINE_ID_SALT", category: "security", desc: "Salt for stable machine ID hashing", default: "endpoint-proxy-salt", secret: true },
  { name: "API_KEY_SECRET", category: "security", desc: "HMAC secret for generated API keys", default: "endpoint-proxy-api-key-secret", secret: true },
  { name: "ROUTER_API_KEY", category: "security", desc: "Override of the local API key used by MITM/tray", default: "(generated)", secret: true },
  { name: "AUTH_COOKIE_SECURE", category: "security", desc: "Force Secure auth cookie (set true behind HTTPS reverse proxy)", default: "false", secret: false },
  { name: "TRUST_PROXY", category: "security", desc: "Honor X-Forwarded-For for rate-limit IP source", default: "false", secret: false },
  { name: "REQUIRE_API_KEY", category: "security", desc: "Enforce Bearer API key on /v1/* routes", default: "false", secret: false },
  { name: "SHUTDOWN_SECRET", category: "security", desc: "Token required to hit /api/shutdown from another process", default: "(auto)", secret: true },

  // --- Network / Proxy ---
  { name: "HTTP_PROXY", category: "network", desc: "Outbound HTTP proxy (also http_proxy)", default: "(unset)", secret: false },
  { name: "HTTPS_PROXY", category: "network", desc: "Outbound HTTPS proxy (also https_proxy)", default: "(unset)", secret: false },
  { name: "ALL_PROXY", category: "network", desc: "Catch-all outbound proxy (also all_proxy)", default: "(unset)", secret: false },
  { name: "NO_PROXY", category: "network", desc: "Comma-separated hosts that bypass the proxy", default: "(unset)", secret: false },
  { name: "KROUTER_PROXY_URL", category: "network", desc: "Canonical proxy URL written by kRouter when the dashboard toggle is on", default: "(unset)", secret: false },
  { name: "KROUTER_PROXY_MANAGED", category: "network", desc: "Marker so kRouter only clears env it wrote itself", default: "(unset)", secret: false },
  { name: "KROUTER_NO_PROXY", category: "network", desc: "Canonical no-proxy list paired with KROUTER_PROXY_URL", default: "(unset)", secret: false },
  { name: "NINE_ROUTER_PROXY_URL", category: "network", desc: "DEPRECATED — legacy alias for KROUTER_PROXY_URL", default: "(unset)", secret: false, deprecated: true },
  { name: "NINE_ROUTER_PROXY_MANAGED", category: "network", desc: "DEPRECATED — legacy alias for KROUTER_PROXY_MANAGED", default: "(unset)", secret: false, deprecated: true },
  { name: "NINE_ROUTER_NO_PROXY", category: "network", desc: "DEPRECATED — legacy alias for KROUTER_NO_PROXY", default: "(unset)", secret: false, deprecated: true },

  // --- MITM / Tunnel ---
  { name: "DEBUG_MITM", category: "mitm", desc: "Enable verbose MITM logging", default: "false", secret: false },
  { name: "MITM_ROUTER_BASE", category: "mitm", desc: "Override base URL the MITM forwards to (for split deployments)", default: "http://localhost:$PORT", secret: false },
  { name: "MITM_SERVER_PATH", category: "mitm", desc: "Absolute path to the MITM server module", default: "(auto-resolved)", secret: false },
  { name: "TUNNEL_TRANSPORT_PROTOCOL", category: "mitm", desc: "cloudflared --protocol value (auto/http2/quic)", default: "auto", secret: false },
  { name: "TUNNEL_WORKER_URL", category: "mitm", desc: "Custom Cloudflare Worker URL for proxy pool tunneling", default: "(default worker)", secret: false },
  { name: "CLOUDFLARED_PROTOCOL", category: "mitm", desc: "Override cloudflared transport protocol", default: "(unset)", secret: false },

  // --- OAuth ---
  { name: "KIRO_OAUTH_CLIENT_ID", category: "oauth", desc: "Override Kiro OAuth client ID", default: "(built-in default)", secret: true },
  { name: "KIMI_CODING_OAUTH_CLIENT_ID", category: "oauth", desc: "Override Kimi Coding OAuth client ID", default: "(built-in default)", secret: true },

  // --- Observability ---
  { name: "OBSERVABILITY_ENABLED", category: "observability", desc: "Master toggle for in-DB request/translator logging", default: "true", secret: false },
  { name: "ENABLE_REQUEST_LOGS", category: "observability", desc: "Write request/response logs to disk under <repo>/logs/", default: "false", secret: false },
  { name: "ENABLE_TRANSLATOR", category: "observability", desc: "Enable translator-layer payload capture for debug", default: "false", secret: false },
  { name: "OBSERVABILITY_BATCH_SIZE", category: "observability", desc: "Rows flushed per batch (perf tradeoff)", default: "50", secret: false },
  { name: "OBSERVABILITY_FLUSH_INTERVAL_MS", category: "observability", desc: "Max ms a row can sit in the batch before flush", default: "5000", secret: false },
  { name: "OBSERVABILITY_MAX_RECORDS", category: "observability", desc: "Max rows kept in DB (older rows pruned)", default: "10000", secret: false },
  { name: "OBSERVABILITY_MAX_JSON_SIZE", category: "observability", desc: "Max JSON blob size kept per row (bytes)", default: "32768", secret: false },
  { name: "KEEP_ALIVE_TIMEOUT", category: "observability", desc: "HTTP keep-alive timeout (ms)", default: "(framework)", secret: false },

  // --- Updater ---
  { name: "UPDATER_PKG_NAME", category: "updater", desc: "npm package the in-app updater installs", default: "@sifxprime/krouter", secret: false },
  { name: "UPDATER_APP_PORT", category: "updater", desc: "Port to wait for after restart", default: "20128", secret: false },
  { name: "UPDATER_PORT", category: "updater", desc: "Updater control port", default: "20129", secret: false },
  { name: "UPDATER_RETRIES", category: "updater", desc: "npm install retry count", default: "3", secret: false },
  { name: "UPDATER_LINGER_MS", category: "updater", desc: "Linger time after updater finishes before exit", default: "30000", secret: false },
];

export const CATEGORIES = [
  { key: "app", label: "App", icon: "tune" },
  { key: "security", label: "Security", icon: "shield" },
  { key: "network", label: "Network / Proxy", icon: "vpn_lock" },
  { key: "mitm", label: "MITM / Tunnel", icon: "swap_horiz" },
  { key: "oauth", label: "OAuth", icon: "key" },
  { key: "observability", label: "Observability", icon: "monitoring" },
  { key: "updater", label: "Updater", icon: "system_update" },
  { key: "other", label: "Other (uncatalogued)", icon: "help_outline" },
];

const CATALOG_NAMES = new Set(ENV_VAR_CATALOG.map((e) => e.name));

// Used by the dashboard API route to detect uncatalogued KROUTER_* / NINE_ROUTER_* /
// app-prefixed vars actually set in process.env so users see everything.
export function isCataloguedEnvVar(name) {
  return CATALOG_NAMES.has(name);
}
