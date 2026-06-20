# v0.5.11 (2026-06-20) — CLI menu reliability + final 9router scrub

Two real bug fixes + the last batch of standalone cleanups.

## Bug fixes

### CLI terminal-UI was reading the wrong field name
The 0.5.10 standalone cleanup renamed the API response field
`has9Router` → `hasKRouter` everywhere — but only on the WEB dashboard
side. `cli/src/cli/menus/cliTools.js` (the in-terminal `krouter` menu
that lets you configure Claude / Codex / OpenCode / etc. from the
prompt) still read `has9Router`, got undefined, and silently treated
every installed IDE as "not configured." Tooling-status checks in the
TUI were effectively broken since 0.5.10. Fixed.

### Arrow-key "move down sometimes doesn't work" on first menu
When you run `krouter`, the interface menu appears after ~2 seconds
(server warm-up). Impatient users press arrow keys during that wait.
The bytes sit in stdin's cooked-mode buffer. When raw mode engages and
the keypress listener attaches, those buffered bytes arrive as a flood
of half-parsed escape sequences — `\x1b[B` (down arrow) sometimes gets
fragmented across reads, so the first one or two presses register as
garbage instead of a `down` event. Now `selectMenu` calls `drainStdin()`
right after `primeRawOnce()`, discarding any pre-menu buffered bytes so
only keys pressed AFTER the menu is on screen drive selection. The
flake disappears.

## Standalone scrub (the rest)

### Stale 9router refs cleaned out of code paths still hit at runtime
  - `cli/src/cli/api/client.js` — last copy of the `~/.9router` →
    `~/.krouter` data-dir migration block. Removed.
  - `cli/src/cli/menus/cliTools.js` — `OR custom:9Router-0` model-id
    fallback + `?? providers["9router"]` dual-read + `(?:krouter|9router)`
    model-prefix regex. All tightened to `krouter` only.
  - `src/lib/mcp/stdioSseBridge.js` — global state key
    `__9routerMcpBridges` → `__krouterMcpBridges`; user-visible
    "truncated by 9router bridge" message → "by kRouter bridge"
  - `cli/scripts/build-cli.js` — build-script title + a stale comment
  - `cli/hooks/sqliteRuntime.js` — already cleaned in 0.5.10, verified

### package-lock.json regenerated
The `cli/package-lock.json` still listed `9router` as a bin entry from
when the package.json bin section was changed in 0.5.10. Regenerated.

### Comment cleanup (non-runtime)
About a dozen JSDoc + inline comments updated from "9router" to
"kRouter" across kiroConstants, kiroModels, sessionManager,
commandcode, openai-to-kiro, paramSupport, kiro MITM handler,
tailscale, copilot MITM. Zero behavioral impact.

## Intentional keeps (still grep "9router" if you look)

  - `Footer.js` + `README.md` upstream attribution (MIT license)
  - `MITM cert CN "9Router MITM Root CA"` (changing breaks existing
    user trust stores)
  - `ENCRYPT_SALT "9router-mitm-pwd"` (changing bricks saved sudo
    passwords)
  - `X-CLIENT-TYPE: 9router` / `grok-cli/9router` / `X-Msh-Platform:
    9router` HTTP headers (3rd-party APIs whitelist by name)
  - `claudeAutoPing.js` + `capabilities.js` port-source comments
    (factual provenance notes)
  - Linux trust-store: uninstall path still removes BOTH
    `9router-root-ca.crt` AND `krouter-root-ca.crt` so a
    pre-rebrand user's keychain stays clean

## Verified
  - 605 pass + 20 expected-fail + 27 fail (identical baseline, zero regressions)
  - node --check on every modified file passes
  - cli/package-lock.json bin section now `{"krouter": "cli.js"}` only

## Upgrade path for users on < 0.5.11

If `krouter` works but `9router` ALSO works (leftover shim):
```
npm uninstall -g @sifxprime/krouter
npm install -g @sifxprime/krouter@latest
```

# v0.5.10 (2026-06-20) — standalone: drop 9router legacy plumbing

Cleanup release. The fork has been on its own brand long enough that the
9router → krouter migration plumbing is now dead weight. This release
rips out every legacy compatibility path, dual-read, and migration
helper that hasn't fired in months.

What got dropped
  - `9router` bin alias from `cli/package.json` (only `krouter` works now)
  - `~/.9router → ~/.krouter` auto-migration in dataDir.js, paths.js,
    cli.js, appUpdater.js, updater.js, mitmAliasCache.js — single
    canonical APP_NAME, no LEGACY_* constants
  - Coexistence warning (added in 0.5.8 — moot now)
  - `NINE_ROUTER_*` env var dual-read + deprecation warning in
    outboundProxy.js — only `KROUTER_*` is recognized
  - 3 catalog entries for `NINE_ROUTER_*` from the Environment panel
  - "9router" provider key dual-read in 12 IDE settings routes:
    codex, jcode, opencode, openclaw, kilo, droid, copilot, cline,
    deepseek-tui, hermes, claude, cowork — only `krouter` keys read +
    written now
  - `LEGACY_PROVIDER_KEY` / `LEGACY_AUTH_KEY` / `LEGACY_ENV_FILE` /
    `LEGACY_CUSTOM_ID_PREFIX` / `LEGACY_API_KEY_ENV_VAR` constants and
    every site that referenced them
  - `has9Router` legacy API field in 12 IDE settings responses + 12 UI
    components that read it — single `hasKRouter` field everywhere
  - `com.9router.autostart` LaunchAgent / `9router.vbs` / `9router.desktop`
    legacy cleanup helpers in autostart.js — single-entry-per-platform
  - `9router` cmdline pattern in `killAllAppProcesses` (cli.js +
    appUpdater.js) — only matches `krouter`
  - `sk_9router` placeholder API key fallback → `sk_krouter`
  - Stale "9router-relay" Deno deployer label → "krouter-relay"
  - Stale `getLegacyProviderEnvPath()` helper in jcode-settings
  - Comment text mentioning legacy across cli/mitm/translator paths
  - Navigation.js upstream-credit links — redirected to sifxprime/krouter
    (Footer attribution kept — MIT license requirement)

What was intentionally kept
  - Landing Footer attribution to decolua/9router (MIT license)
  - README upstream attribution badges + "hardened fork of 9Router" text
  - 9Router MITM Root CA common name (changing CN would invalidate every
    existing user's installed MITM cert and force them to re-trust)
  - 9router-mitm-pwd encryption salt (used to derive the cert-store
    password key — changing it would brick saved sudo passwords)
  - X-CLIENT-TYPE / X-Msh-Platform / grok-cli/9router HTTP headers
    (third-party APIs whitelist by name)
  - Linux trust-store cert filename uninstall path keeps removing both
    `9router-root-ca.crt` and `krouter-root-ca.crt`

Upgrade impact
  Existing kRouter installs: zero. Anyone running 0.5.7+ has long since
  converged to `~/.krouter` and writes only canonical config keys.
  Users still on the upstream `9router` package who never installed
  kRouter: they need to manually rename `~/.9router` → `~/.krouter`
  before first launch. Anyone in that group is also clearly running
  a different product (upstream is a separate npm package).

Verified
  - node --check on every file in the diff (35+ files)
  - 605 pass + 20 expected-fail + 27 fail — identical baseline, zero
    regressions

# v0.5.9 (2026-06-19) — Windows EADDRINUSE crash-loop fix

Single-purpose patch release. Symptom reported on Windows after upgrading
to 0.5.8:

```
⨯ Failed to start server
Error: listen EADDRINUSE: address already in use 0.0.0.0:20128
⚠️  Server exited (code=1). Restarting in 1s... (1/2)
[repeated forever]
```

Two real bugs surfaced by the upgrade:

1. **`killProcessOnPort` only killed the first PID from `netstat`.** Windows
   Next.js spawns a parent + child pair (the dev runner + the actual
   `next-server`); on graceful shutdown only the parent dies and the child
   inherits the listen socket. Killing just the first PID left the child
   still bound to the port. Now sweeps ALL PIDs returned by `netstat`
   (Windows) / `lsof -ti` (macOS/Linux), uses `taskkill /F /T` to kill the
   whole process tree on Windows, and waits 1s on Windows (vs 500ms
   elsewhere) for the kernel to release the socket.

2. **The restart loop didn't re-kill on EADDRINUSE.** When the first start
   failed because a stale process held the port, `tryRestart` just respawned
   blindly into the same conflict — forever. New EADDRINUSE-aware recovery
   path detects "address already in use" in the captured crash log, runs
   `killAllAppProcesses` + `killProcessOnPort` AGAIN, then probes the port
   with a one-shot `net.createServer` before respawning. If the port is
   still occupied after the cleanup, exits with an actionable error:

   ```
   ❌ Port 20128 is still occupied after attempted cleanup.
      Identify the holder (Windows: netstat -ano | findstr :20128;
      macOS/Linux: lsof -i:20128).
      Either stop that process, or run kRouter on a different port:
      krouter --port <N>
   ```

   No more infinite "Disabling MIT and restarting..." (which was the wrong
   recovery anyway — EADDRINUSE has nothing to do with MITM, which runs on
   port 26139).

Verified
  - node --check passes
  - Isolated unit test: spawn victim child holding port → run kill logic →
    probe → port free → PROBE OK
  - Excludes own PID (won't suicide)

---

# v0.5.8 (2026-06-19) — security, brand polish, performance, upstream catch-up

25 commits since 0.5.7 — full audit pass with live end-to-end verification on the dev machine, zero test regressions throughout.

## Security
- **GHSA-6mwv-4mrm-5p3m — Kiro AWS region SSRF (HIGH).** Port of upstream `126aa24`. Seven `${region}` URL-interpolation sites in `src/lib/oauth/providers.js` and `src/lib/oauth/services/kiro.js` were unvalidated — a malicious value like `region="us-east-1.attacker.com#"` would have redirected the OAuth flow to an attacker host. New `assertValidAwsRegion()` helper with `/^[a-z]{2}-[a-z]+-\d{1,2}$/` allowlist now gates every interpolation. 12/12 attack vectors blocked in unit tests.
- **2 HIGH npm CVEs eliminated.** `undici` 7.0.0–7.27.2 (TLS cert validation bypass in SOCKS5 ProxyAgent + cache disclosure) → 7.28.0; `http-proxy-middleware` 3.0.4–3.0.6 (CRLF injection in `fixRequestBody`) → 3.0.7. Both already in MITM/proxy paths. Only 2 moderate `postcss` advisories remain (transitive via Next 16, fix would be a breaking Next downgrade — left).

## Performance — Anthropic + Antigravity rate-limit storms
- **Claude Usage per-token 3-min cooldown + stale-while-revalidate cache** (`open-sse/services/usage.js`). The Quota Tracker page auto-refreshes every 60s × N connections. Anthropic rate-limits per IP — once any Claude account 429'd, every subsequent call from the same IP also 429'd, blanking the entire Claude card. Now on any 429, that token sits in 3-min cooldown returning cached-good data (slightly stale, real numbers) instead of placeholder. **17× quieter** against Anthropic during cooldown windows. Also skip the legacy admin-only fallback when status is 429 (saves 2 wasted calls per rate-limit event). Cooldown latency dropped 400ms → 6ms (pure-memory, no I/O).
- **Antigravity retry-storm fix** (`open-sse/executors/antigravity.js`). 429 RESOURCE_EXHAUSTED with a 73-min reset was triggering 14-28s of pointless 2-4-8s auto-retries per URL × multiple combo models → up to 4 min per request on big projects. Root causes: regex looked for `"reset after"` but Google sends `"Resets in"`; and we never parsed the canonical `error.details[].retryDelay` field (e.g. `"4406.752244244s"`). New `parseRetryFromErrorJson()` reads the machine-readable RetryInfo first; widened message-text regex covers current Google phrasing, beta Antigravity variant, token-bucket style, and bare durations. Combo now advances to the next model in the same instant.
- **`claudeAutoPing` skips disabled accounts.** When the OAuth-usage endpoint reports `extra_usage.disabled_reason` (e.g. `"out_of_credits"`, `"account_suspended"`), the scheduler stops trying for 1 hour and logs the reason once per state-change. Recovery (credits topped up, suspension lifted) is auto-detected within the next hour and logged. Saves wasted POSTs to `/v1/messages` that Anthropic would reject anyway.

## Bug fixes
- **Kiro MITM dropped images** (`src/mitm/handlers/kiro.js`). When users attached an image in Kiro IDE chat, the AWS-CodeWhisperer→OpenAI converter read `userInputMessage.content` and `userInputMessageContext.toolResults` but ignored `userInputMessage.images[]`. Every image silently disappeared before reaching the downstream model — which would then hallucinate about random files in the filesystem context to fill the gap. Now converts each `{ format, source.bytes }` entry to standard OpenAI `{ type:"image_url", image_url:{ url:"data:image/<mime>;base64,..." } }` content blocks. 8/8 unit test cases (text-only / image-only / text+N / tool+image combo / format normalization jpg→jpeg / malformed-skip / fallback to png).
- **Claude usage misleading "admin permissions" message.** The legacy fallback used to say "requires admin permissions" regardless of why the OAuth endpoint failed. Now branches on the OAuth status: 429 → "rate-limited", 401 → "rejected the access token — try reconnecting", 5xx → "upstream error", other → existing scoped message.
- **Perplexity `/v1/models` endpoint fix** (port of upstream `db4499d`). Perplexity deprecated `/models` (404); switched both test-connection and live-models routes to `/v1/models`.
- **claudeAutoPing dual-write consolidation.** The Providers detail page wrote `settings.claudeAutoPing.connections` from stale local state; the Usage page used safer fetch-then-patch. Toggling auto-ping on Page A then Page B could clobber A's update. Providers page now mirrors Usage's race-safe pattern.

## Features ported from upstream
- **Claude auto-ping** (`740093d`) — warms each Claude OAuth connection's 5h quota window by sending a 1-token "hi" the moment the window resets. Per-connection toggle (bolt icon) on Settings → Providers → Claude AND Dashboard → Usage. New `src/shared/services/claudeAutoPing.js` scheduler + `CLAUDE_AUTOPING_CONFIG` in `src/shared/constants/config.js` + UI integration on both surfaces.
- **Fusion combo strategy** (`87e5c1c`) — third combo strategy alongside fallback/round-robin. Fans the prompt out to all panel models in parallel, then a judge model synthesizes one final answer. Quorum-grace collection caps the straggler penalty (8s after `minPanel=2` succeed); 90s panel hard timeout; anonymized "Source N" labels prevent judge brand-bias; degrades gracefully (0 answers → 503, 1 answer → direct return, 2+ → judge synthesizes). Per-combo strategy `Select` replaces the round-robin toggle; fusion reveals a judge-model picker on the Combos page.
- **Custom vision models in selector** (`5e5e78d`) — user-added `imageToText` custom models now appear in the LLM picker with `capabilities: { vision: true }` instead of being filtered out.
- **Kiro thinking-effort budgets** (`2ff1124`) — Kiro requests with `reasoning_effort: "low"` get 1024 thinking tokens, "high" gets 24576 (was always 16000 default — caused visible CoT to leak into chat on low-effort tasks).
- **Antigravity Gemini schema** (`db9ec3a`) — strip `optional` field from tool schemas before sending to Gemini (Google rejects it).
- **claude-to-openai non-streaming** (`411a589`) — handle OpenAI-format responses from xiaomi-tokenplan -claude models on the non-streaming path; strip `reasoning_content` only when content is non-empty.
- **Image routing prefix collision** (`047fdc8`) — compatible nodes can no longer shadow built-in provider aliases like `cf/...`.
- **Antigravity output_config strip + Xiaomi always-OpenAI** (`3f9382d` partial) — strip Claude adaptive fields Google rejects; always use OpenAI `/chat/completions` for Xiaomi.

## New dashboard surface
- **Settings → Environment panel** (`/dashboard/environment`). 47 catalogued env vars in 8 categories (App, Security, Network/Proxy, MITM/Tunnel, OAuth, Observability, Updater, plus "Other" for uncatalogued `KROUTER_*`/`NINE_ROUTER_*`/`MITM_*`/etc. set in env). Live values shown, secrets masked (`INITIAL_PASSWORD` displays as `to••••••••23`), deprecated `NINE_ROUTER_*` flagged with amber badge, eye-icon to reveal, search + "only show set" filter. New `/api/settings/environment` endpoint, sidebar entry under System → Environment.

## Upgrade safety
- **`NODE_EXTRA_CA_CERTS` env-var migration + dangling autostart sweep** (`src/mitm/paths.js`, `cli/src/cli/tray/autostart.js`). For v0.5.6 → v0.5.7 upgraders who had MITM enabled, the system-wide env var still pointed at `~/.9router/mitm/rootCA.crt`. Every Node child process (including npm) saw the stale path. Now `migrateNodeExtraCaCerts()` updates the OS env var to the new cert path via `launchctl setenv` / `setx` immediately after the dir rename. Plus `sweepDanglingAutostartEntries()` on startup detects + removes LaunchAgent / .desktop / .vbs entries whose binary path no longer exists on disk (e.g. when the legacy `9router` global package was uninstalled).
- **Legacy `~/.9router/` coexistence warning** (`src/lib/dataDir.js`, `cli/cli.js`). Auto-migration only fires when the target is absent. Users who ran a pre-rename build mid-session then upgraded kept two parallel data dirs silently forever. Now warns once per process when both exist, gives exact merge/remove commands. Does NOT auto-delete (user data).
- **`KROUTER_*` env-var aliases with deprecation log** (`src/lib/network/outboundProxy.js`). Proxy env vars were still `NINE_ROUTER_PROXY_URL`/etc. only — users setting `KROUTER_PROXY_URL` were silently ignored. Now dual-reads (canonical preferred), dual-writes (existing IDE/shell hooks keep working), one-shot deprecation warning per process when only the legacy name is set.

## Brand polish
- **Hero CTA link** (`src/app/landing/components/HeroSection.js`) — "View on GitHub" above-the-fold pointed at `decolua/9router`; now `sifxprime/krouter`.
- **README install + quickstart blocks** — `~/.9router` → `~/.krouter`, `sk-9router-XXXX` → `sk-krouter-XXXX`, "Point AI tool at 9router" → "at kRouter"; OpenClaw config example updated to current `krouter` provider key + `sk_krouter` placeholder; env-var table defaults corrected. Upstream-Docker callout section kept unchanged (still correctly documents upstream's published image).
- **Tray icons regenerated as Kodelyth Mark.** `cli/src/cli/tray/icon.png` was stale 32×32 PNG from Jun 13, predating the brand mark — on Windows the tray showed a generic icon. Re-rendered from the exact Sidebar.js inline SVG (rounded-square tile with brand-500 → brand-700 gradient + white chevron forward + 25% ghost trail). `icon.ico` is now **multi-size 16+32+48** instead of single 32×32, so Windows tray renders crisp at every DPI scale. `public/favicon.svg` is now a standalone brand-500 chevron — browser tab matches the rebrand.
- **Update endpoint error string** (`src/app/api/version/update/route.js:7`) — `"9router CLI"` → `"kRouter CLI"`.
- 2 stale `9Router` refs in `cli/src/cli/tray/tray.ps1` + `cli/src/cli/tray/copilot.js` MITM handler + `src/app/globals.css` CSS comment + 2 stale `~/.9router/runtime` doc/log strings.

## LAN-safety polish
- **LAN-exposure warning** (`cli/cli.js`). On default `0.0.0.0` bind, prints a yellow startup line: `⚠ Network-exposed: reachable at http://<lan-ip>:<port> (bound 0.0.0.0). Use --host 127.0.0.1 for local-only.` Previously you had no signal the dashboard was reachable from your LAN. Port of upstream's `getLanIp` helper.

---

# v0.5.7 (2026-06-18) — kRouter rebrand: visible surfaces + safe migrations

Final rebrand pass turning every user-visible "9router/9Router" identifier into the canonical `krouter/kRouter` name, with one-time migrations on disk so existing v0.5.x installs upgrade cleanly with zero data loss and zero double-launch.

## Data directory rename with auto-migration
- `~/.9router/` → `~/.krouter/` (Windows: `%APPDATA%\9router\` → `%APPDATA%\krouter\`). Idempotent `fs.renameSync` runs on first launch only when the new dir doesn't exist and the legacy one does — wired into five separate entry points (`src/mitm/paths.js`, `src/lib/dataDir.js`, `cli/cli.js`, `cli/hooks/sqliteRuntime.js`, `cli/src/cli/api/client.js`) so any process startup path migrates.
- Linux MITM trust-store file renamed `9router-root-ca.crt` → `krouter-root-ca.crt`. Uninstall removes both.
- macOS keychain CN unchanged ("9Router MITM Root CA") — keychain trusts by CN not file path, so the cert moves with the data dir and HTTPS keeps working with zero re-trust prompts.

## CLI tools rename with dual-read backward compat
Every IDE config writer (OpenCode, OpenClaw, JCode, Codex, Kilo, Cline, Copilot, Hermes, DeepSeek-TUI, Droid, Cowork-MCP) now writes the canonical `krouter` provider key, and detects the legacy `9router` key as a read-fallback. On the next "Apply" click the user's IDE config converges to canonical names. Specifics:
- OpenCode `provider["krouter"]`, model prefix `krouter/`, dual-match regex `^(?:krouter|9router)\/`
- OpenClaw `providers["krouter"]` in `models.providers`, `agents.list`, and per-agent `models.json`
- JCode `providers["krouter"]`, env file renamed `provider-krouter.env`, env var `JCODE_KROUTER_API_KEY`; legacy env file removed on write; CLI flag now `jcode --provider-profile krouter`
- Codex `model_provider = "krouter"`, `[model_providers.krouter]` section; legacy section removed on next save
- Droid `custom:kRouter-N` IDs; legacy `custom:9Router-N` detected as fallback
- 25+ `sk_9router` localhost placeholder API keys → `sk_krouter` (not validated server-side, safe to rename)
- localStorage key for endpoint presets migrated; legacy key read once then removed

## CLI / system-tray visible surfaces
- Tray menu label + tooltip: `9Router (Port N)` → `kRouter (Port N)`
- Console messages: `🔔 9Router is running in tray` → `🔔 kRouter ...`
- Terminal UI title + breadcrumb: `📡 kRouter Terminal UI`
- macOS plist log paths: `/tmp/krouter.log` + `/tmp/krouter.error.log`
- npm postinstall log prefix: `[krouter] runtime SQLite deps ready`
- Tray + SQLite runtime npm-package name: `krouter-runtime`
- Linux .desktop `Name=kRouter`, `Comment=kRouter API Proxy`

## Autostart bundle ID migration with self-kill protection
The macOS LaunchAgent identifier moved from `com.9router.autostart` → `com.krouter.autostart`. A `cleanupLegacyMacOSAutostart()` helper runs on every enable/disable: unloads the legacy plist with launchd, deletes the file from `~/Library/LaunchAgents/`, then writes the new one. Self-kill protection: if the current Node process IS the running legacy launchd-managed agent, the unload step is skipped (would SIGTERM us mid-execution) — file removal alone is sufficient, launchd releases the agent on next login. Linux `.desktop` and Windows `.vbs` filenames migrate the same way (legacy file removed before new file written). `isAutoStartEnabled()` returns true for either entry so a pre-rename install still reads as enabled until next toggle.

## Dashboard sidebar wordmark
Now rendered in CAPITAL via Tailwind `uppercase` + 0.04em tracking — `KROUTER` with `v0.5.7` below. Kodelyth Mark on the brand-orange tile unchanged.

## Intentionally NOT changed
- HTTP wire-protocol identifiers (`X-CLIENT-TYPE`, `X-Msh-Platform`, `grok-cli/9router` user-agent, `x-9r-cli-token`, `9r-cli-auth`) — sent to/shared with third-party services or between client+server; renaming requires coordinated changes with no user benefit.
- `decolua/9router` upstream-credit links in landing nav/footer — intentional attribution to fork source.

## Verification on maintainer's machine
- `~/.9router/` (1.4 MB `data.sqlite`, auth, jwt-secret, machine-id, MITM cert) → `~/.krouter/` migrated in-place, all files intact, zero data loss.
- `com.9router.autostart.plist` cleanly removed; `com.krouter.autostart.plist` registered with launchd, PID 94237 running, exactly one router process (no double-launch).
- `/api/version` HTTP 200 from dev server; every cli-tools settings endpoint compiles and reaches auth gate (HTTP 401), no 500s.
- All 41 modified files pass `node --check`; zero errors or warnings in dev log.

---

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