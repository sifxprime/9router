# v0.4.80+sifxprime.1 (2026-06-15) — fork hardening pass

Hardening overlay on top of upstream `decolua/9router@v0.4.80`. Eleven audit findings closed across nine atomic commits; each fix carries a unit test that reproduces the BEFORE behavior plus live end-to-end verification through Kiro → MITM → router → real provider. Bug 11 from the audit was dropped after empirical disproof.

## Security
- **API SSRF guard on user-supplied `baseUrl`** — `GET /api/providers/[id]/models` now validates the OpenAI-compatible and Anthropic-compatible base URLs. Blocks cloud metadata endpoints (AWS `169.254.169.254`, ECS `169.254.170.2`, Alibaba `100.100.100.200`, GCP `metadata.google.internal`), wildcard binds, and non-`http(s)` schemes. Loopback and private LAN ranges still allowed for self-hosted LLMs. (Bug 3, c8e3636)
- **Timing-safe CLI token compare** — replaced naive `===` with `crypto.timingSafeEqual` via a `safeEqString` helper. 200k-sample test: byte-position timing ratio drops from 2.22× (OLD oracle) to 0.96× (within noise band). (Bug 9, d680881)
- **Per-IP brute-force lockout on auth failures** — new `src/lib/auth/apiAuthLimiter.js`. 10-fail threshold, progressive lockout 30 s → 2 m → 10 m → 30 m, 1 h auto-reset, per-IP isolation. Held in a separate bucket from login attempts. Loopback origins explicitly skip the limiter to avoid collateral damage on the `"unknown"` IP fallback bucket. (Bug 10, d680881)
- **EventStream encoder bounds checks** — `kiro.js` `encodeHeader` now throws on header-name > 255 B and value > 65 535 B; `buildEventStreamFrame` caps total frame at 16 MiB. Prevents silent uint8/uint16 wrap-around producing corrupt frames that surface in Kiro as `"Truncated event message received"`. (Bug 12, 660eaa0)

## Concurrency & Auth
- **No mutation of caller credentials on token refresh** — `chatCore.handleChatCore` replaced `Object.assign(credentials, newCredentials)` with `{ ...credentials, ...newCredentials }` and threaded the new object into the retry. Eliminates a race where two concurrent requests sharing the same credentials reference could see each other's tokens swapped mid-stream. (Bug 1, 6020127)
- **Retry response always adopted after refresh** — the 401-retry block no longer keeps the stale 401 when the retry returns non-ok or throws. Downstream `parseUpstreamError` now reports the actual failure cause instead of `"Unauthorized"`. (Bug 2, f009fca)
- **Atomic `backoffLevel` read-modify-write** — new `updateProviderConnectionAtomic(id, computeUpdates)` in `connectionsRepo.js`; `markAccountUnavailable` rewritten to compute inside the transaction. Concurrent failures no longer lose increments and stall exponential backoff at +1. (Bug 8, a16f685)

## MITM stream layer
- **Upstream HTTP errors surfaced to Kiro as `exception` frames** — `pipeTransformedEventStream` previously hard-coded HTTP 200 with content-type `application/vnd.amazon.eventstream` and dropped the upstream body for any non-OK response. Now reads the error body and emits a parseable AWS EventStream frame with `:message-type=exception` carrying the upstream message. (Bug 6, a05186a)
- **Pipe loops resilient to mid-stream read errors** — `pipeSSE`, `pipeTransformedSSE`, `pipeTransformedEventStream` now wrap the read loop in `try/catch/finally`. On `ECONNRESET` / `socket hang up` / abort: log, run transform-flush, emit a terminal frame (EventStream exception or SSE `[DONE]`), guarantee `res.end()`. Previously the client connection hung until the OS-level socket timeout. Verified: fake router that destroys mid-stream now closes the curl client in ~300 ms with a parseable terminal frame instead of hanging. (Bug 7, 14da886)
- **MITM `requestTimeout = 0`** — disabled Node's default 5-minute `requestTimeout` and `headersTimeout` on the MITM HTTPS server so long-running agentic streams (Kiro extended-thinking, multi-tool analysis) aren't cut mid-frame. (baseline, 6457f87)

## Routing & efficiency
- **Combo recursion depth guard** — added `MAX_COMBO_RECURSION_DEPTH = 3`. A misconfigured combo that cycles (`comboA → comboB → comboA`) or chains too deep now returns HTTP 400 `"Combo recursion limit exceeded"` instead of overflowing the call stack. (Bug 5, 21e8390)
- **Single `getSettings()` per request** — `chat.js` previously read settings 2–3× per request (top-level + inside the `while(true)` account-fallback loop + a third time in the nested-combo branch). Now read once at the top of `handleChat` and threaded through. (Bug 4, 21e8390)

## Verification methodology
Every fix shipped with:
- A standalone Node test file that **reproduces the BEFORE behavior** under controlled conditions (race simulations, mock streams that throw mid-read, statistical timing of `===` vs `timingSafeEqual`, etc.) and confirms the **AFTER** behavior fixes it.
- A live end-to-end run through the full stack (real Kiro client → MITM → 9router dev server → real provider), verifying the happy path still returns the expected 200 / 551 B / 4-frame EventStream and that the bug-trigger conditions produce the documented graceful behavior.
- For SSRF (Bug 3): live tests with temp DB rows confirming `169.254.169.254` blocks at HTTP 400 + reason, `api.openai.com` reaches upstream, `192.168.x` LAN IPs pass through to the fetch.
- For Bug 11 (audit drop): empirical test of `pipeWithDisconnect` showed `upstream.cancel()` fires within 1 ms of client disconnect via `reader.cancel()` propagation through `pipeThrough`. The "fake writer" stub is necessary (the writable side is locked by `pipeThrough`) and harmless. No fix needed.

# v0.4.80 (2026-06-13)

## Features
- Vercel AI Gateway: support embeddings, images and credit usage (#1183)
- Add MiMo Free no-auth provider (#1789)
- Vertex: support ADC `authorized_user` credential
- Cowork: re-enable Claude Cowork with preset-only stdio MCP
- Codex: bulk add accounts via JSON (#1719)
- Kiro: enable multi-endpoint failover for GenerateAssistantResponse (#1722)

## Fixes
- Security: re-auth on DB export/import + SSRF guard on web fetch
- Auth: real client IP rate-limiting + remote default-password guard
- Cerebras/Mistral: strip unsupported `client_metadata` from downstream requests (#1742)
- SiliconFlow: update baseUrl `.cn` -> `.com` + curate verified model list (#1760)
- Gemini-to-OpenAI: route unsigned thought parts to `reasoning_content` (#1752)
- Claude-to-OpenAI: strip Anthropic billing header from system prompt (#1765)
- Anthropic-compatible: send Bearer auth for third-party gateways (#1795)
- Usage-stats: avoid partial stats on initial SSE race (#1767)
- Proxy: use `export default` in proxy.js for Next.js 16 middleware detection
- Claude passthrough: add body normalization
- GitHub Copilot: refresh missing/expired token on models discovery (#1727) + add mappable gpt-5-mini/gpt-5.4-nano slots for Copilot MITM (#1653)
- Kiro: auto-resolve profileArn to prevent 403 on IDC login, enhance profile ARN resolution, update endpoint to `runtime.us-east-1.kiro.dev` (#1713)
- Tunnel: detect system-installed Tailscale via dual-socket probe (#1723) + non-blocking probes to prevent UI freeze
- CommandCode: force `stream=true` in transformRequest (#1706)
- Qoder: increase timeouts for reasoning models and improve stream handling
- Dashboard: show provider node name instead of connection name in topology (#1770) + show explicit `kind="llm"` combos on combos page (#1684)

## Docs
- README: add Indonesian 9Router tutorial video (#1709)

# v0.4.71 (2026-06-06)

## Features
- Caveman: add wenyan classical Chinese levels and sync upstream prompts; locale-based visibility on endpoint page
- i18n: endpoint exposure notice across multiple languages + Russian README
- Antigravity: add gemini-3.5-flash-extra-low (Low) model
- xiaomi-tokenplan: add Claude-native MiMo V2.5 Pro alias via dedicated executor
- Qoder: fetch latest model + dashboard import-model button (#1642)
- MiniMax: add MiniMax-M3 + update Quota Tracker coding/CN (#1631)

## Fixes
- Codex: harden streaming timeouts (stall/connect raised to 60s, configurable per-provider), accept `response.done` event, and always emit a terminal `response.failed` + `[DONE]` for Responses passthrough when a stream closes, stalls, or aborts before a terminal event — prevents codex clients from hanging (#1648, #1680, #1688, #1618)
- Codex: durable OAuth refresh lifecycle (#1664)
- Tunnel: skip virtual interfaces to prevent false netchange watchdog
- Claude: fix forced tool_choice 400 on cc/ OAuth route (#1592)
- Proxy: raise Next client body limit to 128MB via `NINEROUTER_PROXY_CLIENT_MAX_BODY_SIZE` (#1529, #1572)
- MiniMax: echo `reasoning_content` on follow-up turns to avoid 400 (#1543)
- Kiro: handle 400 on tool-bearing history without client tools; add mappable "auto" model slot; fix binary EventStream crash + add models & TTS tool filtering
- Antigravity: passthrough tab-autocomplete + mark default agent slot mandatory
- Qoder: allow `qmodel_latest` model key (#1638)
- Providers: restore one-connection guard for compatible/embedding nodes
- Model-test: route image/STT probes to their real endpoints, harden STT ping; add opencode-go + xiaomi-tokenplan to connection test (#1576, #1628)

## Improvements
- Dashboard: reorganize menu actions across sidebar/header/profile
- Translator: add data-driven coverage, bug-exposing cases, and real provider smoke tests

# v0.4.66 (2026-05-29)

## Features
- Add Qoder provider: device-flow OAuth, COSY signing, WAF-bypass body encoding, live model catalog, dashboard quota tracker, 11 models (#1372)
- Add new models: Claude Opus 4.8 (Claude Code), GPT 5.4 Mini (Codex)

## Fixes
- DeepSeek thinking mode: echo `reasoning_content` back on follow-up/tool-call turns so OpenCode-free and custom providers no longer 400 with "reasoning_content must be passed back" (#1543)
- Reasoning injector: match deepseek/kimi model ids case-insensitively (covers custom providers using capitalized model names)
- OpenCode suggested-models: include free models without the `-free` suffix, e.g. `big-pickle` (#1535)

## Improvements
- Codex: trim sunset models, keep gpt-5.5 / gpt-5.4 / gpt-5.3-codex family, add gpt-5.4-mini
- volcengine-ark: refresh model list (add DeepSeek-V4-Flash/Pro, drop EOL entries)
- Lower stream stall timeout 35s → 30s for faster hang detection

# v0.4.63 (2026-05-26)

## Fixes
- GitHub Copilot: never route Gemini/Claude models to the `/responses` endpoint; prevents misleading "does not support Responses API" 400s (#1062)
- proxyFetch: restore missing `Readable` import causing runtime `ReferenceError` in DNS-bypass fetch path

## Improvements
- Lower stream stall timeout from 60s → 35s for faster hang detection

# v0.4.62 (2026-05-26)

## Fixes
- Codex: auto-retry when upstream drops mid-stream (no more hangs)
- Codex: fix random 400/404 errors, tool-calling failures, and unstable prompt cache
- MITM: support Antigravity 2.x 
- Sanitize Read tool args to prevent retry loops from non-Anthropic models (#1144)
- Implement json_schema fallback for OpenAI-compatible providers without native Structured Output (#1343)
- Strip empty Read pages argument in OpenAI-to-Claude translator (#1354)
- Forward Gemini output dimensions for embeddings (#1366)
- Resolve setState-in-effect errors in dashboard components (#1362)
- Gemini CLI: reuse stored OAuth project IDs for quota checks and show clearer setup guidance when the project is missing (#1271, #1428)

## Features
- Add Cloudflare Workers proxy deployer and pool integration (#1360)
- Add Deno Deploy relays support and improved proxy pools dashboard layout (#1437)

## Improvements
- Refactor Tunnel into dedicated Cloudflare and Tailscale manager modules
- Refactor tokenRefresh service with in-flight dedup to prevent refresh_token_reused errors

# v0.4.59 (2026-05-21)

## Fixes
- OAuth: fix login flow on Windows

# v0.4.58 (2026-05-21)

## Features
- xAI Grok provider (OAuth, API key, image)
- Provider limits: paginated accounts with page size controls

## Fixes
- Tailscale: fix connection status on Windows (#1300)
- Tunnel: fix false "checking" when tunnel URL is reachable
- Stream: fix pipe errors on client disconnect/abort

# v0.4.55 (2026-05-18)

## Features
- Xiaomi MiMo Token Plan: region selector (Singapore / China / Europe) — keys are cluster-specific
- Antigravity: risk confirmation dialog before first connection
- Gemini CLI: surface upstream retry delay on 429 errors

## Fixes
- MITM: cannot kill process on macOS under sudo (lsof not found in PATH)
- Stream: false-positive stall timeout on Claude reasoning / Kiro responses
- Tunnel: cannot re-enable after disable (stuck state)
- Tunnel: cloudflared error messages now include log tail for easier debugging
- Language switcher: applies selected locale immediately on close (#1234)
- Antigravity OAuth: metadata now matches the official client

## Improvements
- Gemini CLI: bump engine to 0.34.0
- Re-hide `qwen` (OAuth EOL) and `iflow` (not ready) providers

# v0.4.52 (2026-05-17)

## Features
- Add Vercel AI Gateway provider support (#1183)
- rtk: Kiro format tool result compression — handle conversationState.history & currentMessage, preserve error results, ~13.6% savings (#1194)

## Fixes
- openclaw: normalize agent.model object form `{primary, fallbacks}` before .startsWith → fix TypeError & 'not configured' status (#1216)
- Usage Details pagination: stay inside mobile viewport <640px (#1218)
- Fix test model error
- Fix MIMO provider in Codex
- Disable log file creation when using MITM AG

# v0.4.50 (2026-05-16)

## Fixes
- Fix duplicate tray icon on macOS when hiding to tray
- Fix tray not showing in background mode on macOS
- Fix hide to tray broken on Windows/Linux
- Fix Shutdown button in web UI not working

# v0.4.49 (2026-05-16)

## Features
- Add Kiro provider support: full request/response translation, live model listing, reasoning content support
- Add `buildOutput` RTK filter with autodetect for npm/yarn/cargo build logs
- Add MITM warning notification in tray and dashboard

## Improvements
- Add modalities (input/output) to model configuration for OpenCode
- Fix tray hide-to-tray: keep current process alive instead of spawning detached child (fixes macOS NSStatusItem ghost icon)
- Fix tray kill: graceful shutdown with SIGTERM/SIGKILL escalation
- Fix SIGHUP handling so macOS terminal close doesn't kill tray process
- Hide deprecated providers (qwen, iflow, antigravity)
- Update i18n across 32 languages

## Fixes
- Fix model check (test-models) blocked by dashboardGuard: pass machineId-based CLI token in internal self-calls

# v0.4.46 (2026-05-15)

## Breaking Changes
- Tunnel public URL changed — old tunnel links no longer work, please reconnect to get the new URL

# v0.4.44 (2026-05-15)

## Features
- Add Blackbox provider with `bb` alias (#1143)
- Add Xiaomi token plan provider
- Enhance model select modal UX + modal traffic lights (#1111)
- Default Usage dashboard period to Today (#1141)

## Fixes
- Fix Cowork model selection and Windows CLI packaging (#1129)
- Update provider name retrieval for compatibility provider (#1135)
- Update JWT_SECRET handling

# v0.4.41 (2026-05-14)

## Features
- Add jcode CLI tool integration with auto-configuration (#1047)
- Redesign CLI Tools dashboard: grid layout (1/2/3 cols) + dedicated detail page per tool
- Add drag-and-drop reordering for combo models (#1108)
- Add Today period option to Usage & Analytics (#1063)
- Add DeepSeek V4 Pro effort aliases (#950)

## Fixes
- fix(autostart): work on nvm + npm 9/10, actually register with launchctl (#1104, fixes #1082)
- Fix Ollama usage not tracked/shown in UI (#1102)
- fix(opencode): preserve DeepSeek reasoning content (#1099, fixes #1093)
- Fix TUI input lag (replace enquirer with native readline, persistent raw mode)
- fix(ui): show API key row actions on mobile (#1112)

## Improvements
- Sync DeepSeek TUI card style with other CLI tools (badges, layout, manual config modal)
- Add official logos for Amp CLI, jcode, Qwen Code (replace generic icons)
- Resize deepseek-tui icon 1024→128 with padding for visual consistency

# v0.4.39 (2026-05-14)

## Fixes
- fix(docker): restore `/app/server.js` (v0.4.38 regression)

# v0.4.38 (2026-05-13)

## Features
- Add DeepSeek TUI as CLI tool in dashboard (#1088)

## Fixes
- Fix broken Docker image in v0.4.36/v0.4.37 (#1096, #1097)

## Improvements
- Clean Docker tags + clearer pulls badge

# v0.4.37 (2026-05-13)

## Improvements
- Security hardening — upgrade recommended

# v0.4.36 (2026-05-13)

## Features
- Add MiniMax TTS provider support (#1043)
- Docker images now published on both Docker Hub (`decolua/9router`) and GHCR — pull from your preferred registry

## Improvements
- Replace browser confirm dialogs with custom ConfirmModal (#1060)

## Fixes
- Fix Docker `Cannot find module 'next'` error in standalone build
- Restore /app/server.js in Docker standalone build (#1064, #1067)
- Fix CLI TUI menu arrow-key escape sequences leaking (^[[A^[[B)
- Switch macOS/Linux tray to systray2 fork (fixes Kaspersky AV false-positive) (#1080)
- Fix zoom controls contrast in topology view (#1066)