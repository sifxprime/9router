# v0.5.69 (2026-06-28) — Stop TPM downgrade from re-classifying daily Antigravity exhaustion

User log audit showed two Antigravity accounts spamming the same 429 "Individual quota reached. Resets in 2h27m" error every 90 seconds. Root cause traced to 0.5.49 TPM disambiguation: the code re-classifies "quota reached" 429s as TPM when the cached daily-quota number says the account is healthy. But the quota cache lags behind reality, so real daily exhaustion got downgraded to a 90 s TPM cooldown, and the picker tried the dead account again 90 s later. Loop.

Two-part fix:

1. **Refuse the TPM downgrade when Google explicitly says "Resets in Nh"** or "Resets in N hour(s)/day(s)" - TPM windows reset in seconds-to-minutes, never hours. The new regex (`resets?\s+in\s+\d+h`) catches the exact wording Google ships. Real daily/weekly exhaustion now keeps its honest cooldown (capped at MAX_RATE_LIMIT_COOLDOWN_MS = 30 min) instead of getting reclassified to 90 s.
2. **Force-invalidate the cached daily quota for the account+model** when we detect an hours/days reset, so subsequent picks see fresh data and don't trip the same TPM trap on the next turn for a different model on the same account.

Net effect: the spammy "Resets in 2h27m" loop stops. Accounts that genuinely have only a TPM bottleneck still get their 90 s fast-path. The dashboard log goes back to being readable.

# v0.5.68 (2026-06-28) — Suppress false-positive MaxListeners warning

Raised `process.setMaxListeners` from 20 to 50 to accommodate the HTTP/2 connection pool added in 0.5.67. Each pooled `http2.connect()` session attaches internal SIGTERM/exit/beforeExit listeners to `process`. With 6+ Antigravity accounts and parallel IDE requests, 21+ sessions can be alive before the 30s idle timeout fires, triggering Node's `MaxListenersExceededWarning`. Not a real memory leak — sessions are cleaned up on idle/error/GOAWAY. The warning is now silenced.

# v0.5.66 (2026-06-28) — Fix Claude CLI Bash safety classifier (gpt-5.5) + CLI Tools connection status

Two bug fixes based on user problem reports:

1. **Claude CLI Bash Safety Classifier Fix (OpenAI/Codex `gpt-5.5`):** Claude CLI makes a safety pre-check before running Bash commands, requesting `max_tokens: 1` to get a single YES/NO token. Recent OpenAI/Codex backend updates strictly reject `max_tokens < 16` with an HTTP 400 error. Claude CLI misinterpreted this 400 as `cx/gpt-5.5 is temporarily unavailable, so auto mode cannot determine the safety of Bash right now.`. k‍Router now enforces a hard floor of `max_tokens: 16` for all OpenAI formats to pass upstream validation.
2. **CLI Tools Connection Status UI Fix:** Fixed a bug where the CLI Tools index cards on the dashboard always showed `Not configured` even when the tool was fully connected. The settings API routes (`claude`, `cowork`, `jcode`) were computing `hasK‍Router` correctly but omitting it from the JSON response.

# v0.5.65 (2026-06-28) — Kiro IDE first-class support + Caveman/Ponytail mutex

Four bundled fixes from a full kRouter debug pass.

A. Kiro native passthrough. Added `"kiro": ["kiro"]` to `NATIVE_PAIRS` and a Kiro IDE detection branch in `detectClientTool()` matching `user-agent: kiro`, `x-amzn-codewhisperer-source: kiro`, `x-amz-target: AmazonCodeWhispererService.*`, and request-body shape (`conversationState`/`userInputMessage` presence). When Kiro IDE talks to the Kiro provider through MITM, the body is now forwarded byte-perfect — AWS Bedrock prompt caching survives and we skip the 500-line openai-to-kiro translator entirely. Verified: `detectClientTool({user-agent: 'kiro/1.0'}) === 'kiro'` and `isNativePassthrough('kiro', 'kiro') === true`.

B. Kiro persona-injection slot. `systemInject.js` and `caveman.js` previously fell through to OpenAI shape for Kiro — meaning persona prompts silently no-oped on Kiro requests. Added an explicit Kiro case that prepends the persona to `body.conversationState.currentMessage.userInputMessage.content` (Kiro's translator normalises system role into user content, so there is no separate system slot). Verified live: persona text now appears at the start of the Kiro request body.

B(UI). Dashboard mutex. `EndpointPageClient.js`: turning Caveman on now auto-toggles Ponytail off and vice versa, both in React state and in the persisted setting. Users can pick one persona; choice is honoured for every subsequent request.

C. Runtime guard against double persona injection. `chatCore.js` previously claimed Caveman and Ponytail "compose because they target different aspects". They don't — both prompts declare "ACTIVE EVERY RESPONSE" and contradict on tone (caveman = terse fragments; ponytail = lazy-dev ladder with 3-line output template). Gemini in particular went schizo. Now: if a legacy settings row still has both enabled, prefer Ponytail and log a `[PERSONA] Caveman + Ponytail both enabled — skipping Caveman` warning so the user sees it and can fix on the dashboard.

D. Demoted `[Claude Usage] OAuth endpoint returned 403` from `warn` to opt-in debug. Anthropic deprecated the OAuth usage endpoint for some account tiers; the legacy fallback in `getClaudeUsageLegacy()` always works. The warning was firing every 30 seconds against a perfectly healthy dashboard.

# v0.5.64 (2026-06-27) — Remove notify-krouter-web workflow

The notify-krouter-web workflow (added in 5cc370f) pinged the krouter-web marketing site whenever providers / CHANGELOG / package.json changed. That repo isn't being used, so the workflow has just been failing with 404 on every push. Removed.

# v0.5.63 (2026-06-27) — Sanitize tool_use IDs on Claude passthrough (Google-to-Claude cross-IDE fix)

User reported that switching IDEs mid-conversation between Google (Antigravity / Gemini) and Claude was failing. Root cause traced in logs: Anthropic returns `400 invalid_request_error` on `messages.N.content.M.tool_use.id` because Google emits tool_call IDs containing dots/colons/slashes, which violate Claude's required pattern `^[a-zA-Z0-9_-]+$`. The general translator path already calls `ensureToolCallIds()`, but the Claude direct passthrough path (and the cache-preserve branch) skipped it entirely — so a conversation that lived part of its life in Gemini and then continued via Claude direct would get rejected.

Now: before sending to any Claude-shape upstream, we scan the body with a lightweight `bodyHasInvalidToolIds()` predicate. If clean (the common case for Claude-only conversations), nothing mutates and the byte-perfect prompt cache survives. If a Gemini-style ID is detected, we invoke the existing `ensureToolCallIds()` sanitizer once and forward the safe body.

# v0.5.62 (2026-06-26) — Documentation update: License & Branding

Documentation-only release. No code changes.
- README: Removed upstream credit badge from the very first line (moved to attribution section below).
- LICENSE: Changed copyright header to strictly "K‍odelyth AI Infrastructure" (with full attribution details at the bottom).

# v0.5.61 (2026-06-26) — Docker deployment parity: sifxprime/k‍router

Configured GitHub Actions workflow to publish Docker container images to `sifxprime/k‍router` on Docker Hub (and `ghcr.io/sifxprime/k‍router` on GitHub Container Registry) instead of the old upstream decolua image. Updated README and DOCKER.md with official container execution commands using `sifxprime/k‍router:latest` and `~/.k‍router` data binding.

# v0.5.59 (2026-06-26) — Documentation update: NPM Install & Uninstall

Documentation-only release. No code changes. README `Quick Start` section rewritten to prioritize NPM installation (`npm i -g @sifxprime/k‍router`) as the primary method for users, moving the Git clone instructions to an "Option 2 (For Development)" section. Added explicit upgrade and uninstallation commands, including how to clean up the `~/.k‍router/` directory.

# v0.5.58 (2026-06-25) — Documentation + LICENSE attribution refresh

Documentation-only release. No code changes. README adds a head-to-head comparison table (kRouter vs upstream 9router vs OmniRoute) and explicit "forked from" attribution. LICENSE updated to dual-copyright the fork (Kodelyth AI Infrastructure / Shofiqul Islam) alongside the upstream copyright (decolua and 9router contributors). CHANGELOG backfilled for the 0.5.35 → 0.5.57 rapid-iteration window with one-line summaries.

# v0.5.57 (2026-06-25) — Preserve thinking intent across the Antigravity blacklist

Kiro IDE through MITM (and other clients sending Claude/OpenAI-shape `thinking` config) were getting plain answers with no reasoning because the antigravity executor blacklist stripped `thinking`, `reasoning_effort`, `thinkingConfig`, etc. without translating them first. Now extracts Claude `{thinking.type=enabled, budget_tokens}` and OpenAI `reasoning_effort` BEFORE the strip and maps to Gemini-native `generationConfig.thinkingConfig`. Verified live: `reasoning_tokens` for gemini-pro-agent went 0 → 237 in end-to-end test.

# v0.5.56 (2026-06-25) — Honest "Exhausted • awaiting reset" quota display

Google's `fetchAvailableModels` omits `remainingFraction` entirely for quota-exhausted Claude models on the free Antigravity tier (3-day window). Our `|| 0` fallback painted these as fake 100%-used red bars. Now distinguishes "0% remaining" from "no number, only resetTime" and renders an amber `Exhausted • awaiting reset in X` bar in that case. UI matches what the official Antigravity desktop shows.

# v0.5.55 (2026-06-25) — Revert: x-request-source scrub broke our own MITM

Reverts the 0.5.47 addition of `x-request-source` to the antigravity header scrub list. Misdiagnosis — Google ignores unknown headers, but `src/mitm/server.js` uses `x-request-source: local` as the INTERNAL_REQUEST_HEADER anti-loop marker. Stripping it caused our outbound HTTPS to cloudcode-pa.googleapis.com to re-enter the MITM intercept and abort with `NGHTTP2_INTERNAL_ERROR` / `socket hang up`.

# v0.5.54 (2026-06-25) — Auto-backfill historical Antigravity tokens on startup

Replaces the manual `krouter backfill-tokens` subcommand with a silent one-shot run inside `initializeApp()`. Walks any `requestDetails` rows where `tokens.prompt_tokens=0` but `providerResponse.response.usageMetadata` carries the real Gemini-shape numbers, lifts them into the top-level `tokens` field. Idempotent on subsequent runs. Users no longer need to know the CLI subcommand exists.

# v0.5.53 (2026-06-25) — Fix backfill SQL quoting

0.5.52's backfill inlined `sqlite3 db UPDATE … data='<JSON>'` per row; embedded curly braces and quotes broke shell quoting so SQLite silently rejected every UPDATE. Now emits all UPDATEs to a temp SQL script and pipes through `sqlite3 db <script` inside a single BEGIN/COMMIT transaction. SQLite parses each statement itself so JSON survives.

# v0.5.52 (2026-06-25) — `krouter backfill-tokens` CLI + log de-noise

Two cleanups bundled. (1) New `krouter backfill-tokens` subcommand rewrites historical 0/0 Antigravity rows that the pre-0.5.51 extractor missed. (2) Demoted two of three token-refresh log lines from info → debug — each refresh used to emit a triplet (`[TOKEN] X refreshed`, `[TOKEN_REFRESH] Credentials updated`, `[TOKEN] X | refreshed`) and now just emits the third (most useful) one.

# v0.5.51 (2026-06-25) — Extract Antigravity's wrapped `usageMetadata`

Antigravity wraps the Gemini response in `{response: {...usageMetadata}}`, so the top-level usageMetadata check in `extractUsageFromResponse` missed it and every Antigravity row landed in DB with `tokens.prompt_tokens=0` even when Google billed thousands. Added a second branch that lifts `response.response.usageMetadata` when present. Verified live: 137 historical rows backfilled to non-zero token counts.

# v0.5.50 (2026-06-25) — Antigravity models fetcher needs `{project}` + headers

The 0.5.45 fix pointed the models endpoint at `cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels` but sent `body: {}` with bare `Content-Type`, producing a flood of `403 PERMISSION_DENIED` HTML pages in the console. Now uses a customResolver that supplies the project ID, the User-Agent / X-Client-Name / X-Client-Version headers the real binary sends, and normalises the `{quotas: {modelId: …}}` response shape.

# v0.5.49 (2026-06-25) — TPM rate-limit vs daily-quota disambiguation

Google's chat endpoint returns the same 429 body (`"Individual quota reached"`) for daily-quota exhaustion AND per-minute TPM throttling. Was applying a 30-minute cooldown to both. Now checks the cached daily quota when a 429 fires: if daily quota is healthy (>10% remaining), reclassifies as TPM (90-second cooldown, account-lock false, lastError reads "TPM rate-limited"). Accounts hit by transient TPM bursts come back in 90s instead of being parked for half an hour.

# v0.5.48 (2026-06-25) — Lazy-clear stale `unavailable` testStatus on read

`clearAccountError` only cleaned expired locks when a request *succeeded* on an account. Idle accounts with all per-model locks expired sat with stale `testStatus: "unavailable"` and 6-hour-old `lastError` text. Now `GET /api/providers` computes an effective `testStatus` on read: if every `modelLock_*` has expired and `isPermanentlyBanned` is false, upgrade `unavailable` → `active` and drop the stale lastError. Dashboard matches reality.

# v0.5.47 (2026-06-25) — Wire `permanent` ban flag through to UI

0.5.46 added `permanent: true` to error rules but nothing read it. Wired through `checkFallbackError → markAccountUnavailable → DB`: permanent bans now set `testStatus: "banned"`, persist `isPermanentlyBanned: true` + `bannedAt: <ISO>`, and Test Connection clears these flags when the account is verifiably alive again. (Also temporarily added `x-request-source` to scrub list — reverted in 0.5.55 after MITM regression.)

# v0.5.46 (2026-06-25) — Root-cause fix for "Verify your account" cascade

Diagnosed in March 2026 on the decolua/9router upstream issue #270, never patched until now. `open-sse/services/antigravityProjectBootstrap.js` was sending STRING enums (`ideType:"VSCODE", pluginType:"GEMINI"`) in loadCodeAssist metadata, while the OAuth flow correctly sends NUMERIC enums (`ideType:9, pluginType:2`). Google's anti-abuse correlates token-vs-bootstrap mismatch and flags the account on its very first call. Bootstrap now uses `getOAuthClientMetadata()` for byte-exact parity. Also ports OmniRoute's permanent-ban classifier: `verify your account` and similar texts now lock the account for 24h with `permanent: true`.

# v0.5.45 (2026-06-25) — Antigravity model-list endpoint + log truncation

The dead `daily-cloudcode-pa.sandbox.googleapis.com/v1internal:models` URL returned a 5KB HTML 404 page on every dashboard load, dumped raw into the console. Switched to the production endpoint already used by `usage.js`. Also truncates upstream error bodies to 200 chars before logging so future 4xx pages don't flood logs.

# v0.5.44 (2026-06-25) — Test Connection actually clears the account-wide lock

When a user clicked Test Connection after verifying at Google's URL, kRouter cleared `testStatus` and `lastError` but **not** `modelLock___all`. The picker kept skipping the account for the rest of the 1h cooldown. Now Test Connection success clears every `modelLock_*` field, resets `backoffLevel` to 0, drops `rateLimitedUntil`, and clears `isPermanentlyBanned` so the account truly comes back into rotation.

# v0.5.43 (2026-06-25) — Stop ZWJ obfuscator from corrupting base64 image data

`obfuscateBodyStrings` walked every string in the request body and injected zero-width joiners into matches of "claude", "cursor", "kodelyth", etc. — to dodge Google's log-grep based fingerprinting. Problem: base64 image data is essentially random text that statistically *will* contain those byte sequences. ZWJ injection inside `inline_data.data` corrupted the base64, causing Google to 400 with `Base64 decoding failed`. Now skips known binary-data field names (`data`, `inline_data`, `bytes`, `b64_json`, etc.) and any string that looks like a `data:image/...;base64,...` URL.

# v0.5.42 (2026-06-24) — Per-provider concurrency + adaptive semaphore timeout

Bumped Kiro 2→4, Claude 3→5 concurrent slots per account. Per-provider semaphore timeouts replace the flat 5s (Kiro 20s, Claude/Codex 15s, Antigravity 5s). Block-on-busy duration scales with timeout. A "hello" prompt with IDE Autopilot used to spend 25s of 503 "busy" loops before the in-flight 28s Kiro requests cleared — now under 5s.

# v0.5.41 (2026-06-24) — Combo fast-path + clearer account-lock logs

Three fixes: (1) Semaphore timeout 30s → 5s. (2) Semaphore timeout now marks the account briefly blocked in memory and returns 503 (not 429) so the combo picker skips it instead of re-selecting. (3) The picker's diagnostic log now writes `ACCOUNT-LOCKED until <time>` when `modelLock___all` is active (previously always said `modelLocked(<one model>)`, misleading).

# v0.5.40 (2026-06-24) — Stage the missing OmniRoute parity files

0.5.37–0.5.39 amended the commit metadata but never staged the actual new files (accountSemaphore, apiKeyRotator, emergencyFallback, modelFamilyFallback, sessionManager, fingerprintRotator, intentClassifier, taskAwareRouter, toolLimitDetector, plus 11 unit-test files). 0.5.40 contains all 30+ files for real.

# v0.5.37 (2026-06-24) — OmniRoute parity port — Fallback / Session / Tooling / MITM

Major port from diegosouzapw/OmniRoute v3.8+. Account semaphore (concurrency cap per account). Emergency fallback on 402 → free model. Model family fallback (try sibling on 404). API key rotator. Session manager (deterministic SHA-256 session IDs). Fingerprint rotator. Header scrubber. ZWJ obfuscation. Tool limit detector (auto-strip non-essential tools on 400). Stream recovery (NGHTTP2 → HTTP/1.1 fallback). Circuit breaker.

# v0.5.36 (2026-06-24) — Model deprecation auto-upgrade + format-specific param strip

Ports modelDeprecation from OmniRoute: auto-upgrades retired/renamed models (e.g. `gemini-1.5-flash` → `gemini-2.5-flash`). Ports modelStrip: proactive + reactive stripping of unsupported parameters (drops `logprobs` for Groq/OSS, retries with `reasoning_budget` stripped if upstream complains).

# v0.5.35 (2026-06-23) — One-click Cache Control panic toggle in Profile

Adds an amber/cyan one-click toggle next to the existing Cache Control dropdown so users hitting fresh-turn 429s can flip between `auto` (cache-preserve) and `never` (RTK trims) without navigating the dropdown twice. Cyan = armed/preserve; amber = legacy trimming.

# v0.5.34 (2026-06-23) — Hotfix: Claude direct cache preservation

Fixes an issue where C‍laude Code (the CLI) would receive `429 Rate Limit` errors on Anthropic Tier 1 accounts despite having sufficient credits.

- **Bug:** `normalizeClaudePassthrough` was hoisting C‍laude Code's mid-conversation `role: "system"` messages to the top level. While semantically identical, this changed the JSON byte sequence, busting Anthropic's prompt cache. A 50k token prompt missing the cache immediately hits the 40k TPM limit on Tier 1.
- **Fix:** `cacheControlMode="auto"` (and `"always"`) now strictly skips the normalizer and tool deduper. The outbound JSON body is now 100% byte-identical to the CLI's payload, allowing Anthropic's cache to hit and bypassing TPM rate limits on continuation turns.

# v0.5.33 (2026-06-23) — cacheControlMode toggle + quota freshness tracking

User-visible: dashboard now exposes a Cache Control toggle (auto/always/never) that controls whether kRouter mutates `cache_control` markers on Claude-shape requests. Quota usage endpoint now reports cache freshness so the dashboard can show "last checked Xs ago" without a second round-trip, and a manual refresh endpoint forces a fresh upstream fetch on demand.

## Cache Control mode toggle (Tier 3.A)
- New setting `cacheControlMode` with three values:
  - **`auto`** (default, preserves 0.5.32 behavior): skip `cache_control` mutations only on Claude direct passthrough (`clientTool==="claude" && provider==="claude"`).
  - **`always`**: paranoid mode — skip mutations on any Claude-shape target including `anthropic-compatible-*` resellers and the explicit translator path (threaded via `prepareClaudeRequest(preserveCacheControl=true)`).
  - **`never`**: legacy escape hatch (pre-0.5.32 strip-and-rewrite behavior).
- New Cache Control card on `/dashboard/profile` with a `<select>` and live mode-aware explainer text.
- Live-verified: dev log fires `[CACHE] mode=auto | token savers SKIPPED...` and `[CACHE] mode=always | token savers SKIPPED...` on real Claude traffic; `never` correctly suppresses the skip.

## Quota tracker hardening (Tier 3.C)
- `quotaPreflight` gains four new APIs:
  - `getQuotaCacheInfo(provider, connId)` → freshness info (`hasData`, `isFresh`, `isStale`, `lastCheckedAt`, `lastCheckedAgoSec`, `modelCount`)
  - `forceRefreshQuota(provider, connId, connection)` → drop cache + inFlight, refetch upstream
  - `recordQuotaCacheHit(provider, connId)` → tracks last-used for background daemon
  - `startBackgroundQuotaRefresh(connectionsProvider)` → 60s daemon that only refreshes accounts whose hot-path read was within the last 30 min
- `GET /api/usage/[connectionId]` now returns `_cacheInfo` with the freshness fields (backward-compatible — added field, nothing removed).
- `POST /api/usage/[connectionId]` is new — manual refresh endpoint that token-refreshes if OAuth, force-refreshes quota cache, returns `{ ...usage, _cacheInfo, _refreshed: true }`.
- `sse/services/auth.js` records a cache hit after every successful account pick, so the daemon's "recently used" detection mirrors real production usage.
- Daemon ticks confirmed live in isolated node process; in-app firing is timer-driven and survives HMR.

## Test counts
- Pre-release baseline: 983 passing / 20 expected-fail / 21 skipped
- Post-release: **999 passing** / 20 expected-fail / 21 skipped (1040 total)
- +16 new tests across 2 new test files: `cache-control-mode.test.js`, `quota-tracker-hardening.test.js`
- Zero regressions

## Intentionally NOT in this release
- TaskAwareRouter wiring (Tier 3.B) — deferred at user request, same rationale as the skipped Tier 2.B combo intelligence wiring in 0.5.32. Existing routing is working and the user opted to leave it untouched.

---

# v0.5.32 (2026-06-23) — Claude Desktop token-burn fix + reliability hardening

User-visible: long Claude Desktop / Claude Code sessions routed through kRouter MITM no longer pay 3-10x token cost vs running Claude direct. Anthropic's per-API-key prompt cache now stays warm across continuation turns.

## Cache preservation in Claude direct passthrough (Tier 1)
- **Skip token-saver mutations for Claude direct passthrough.** When `clientTool === "claude" && provider === "claude"` and the request is in passthrough mode, kRouter no longer runs RTK / Caveman / Ponytail on the outbound body. Any byte change to system / tools / messages prefix busts Anthropic's prompt cache key; for a 50-turn Claude Desktop session that was 50 cache misses × 10× tokens on the cached prefix. Now the outbound body is byte-identical to what Claude Desktop sent and Anthropic's cache hits on every continuation turn.
- **Session-sticky account binding.** `getSessionConnection()` infrastructure existed in `sessionManager.js` but was never called. Wired it: every chat request derives a `conversationFingerprint` (model + system + tools + first user message + provider, **without** connectionId) and resolves it to a sticky account via `getStickyConnection()`. Auth picker honours the binding via `preferredConnectionId`. On a successful turn we re-bind the fingerprint to the working account. Failed binding falls through to normal strategy (option a — drop stickiness rather than wait for recovery). For users with `stickyRoundRobinLimit:1`, this stops every-other-turn cache misses from per-key cache rotation.
- **`preserveCacheControl` flag on `prepareClaudeRequest`** (port of OmniRoute's same-named flag). 4th param, default false. When true, skips all cache_control strip-and-rewrite passes on system blocks, message content, and last-assistant injection. Future translation paths (e.g. `anthropic-compatible-cc-*` resellers) can flip this on without touching chatCore.

Live-verified end-to-end on real Anthropic traffic — 3 successful Claude direct turns through the same conversation fingerprint, all routed to the same account, `[AUTH] claude | pinned to <conn>` log line confirms sticky resolution on turn 3+.

## Reactive 400-retry hardening (Tier 2.A + 2.C)
- **`findOffendingField` word-boundary regex** (already shipped in 0.5.31 commit d20703c, included here). Catches bare-name 400 bodies that the previous quoted-only matcher missed: Groq (`Unknown parameter: logprobs`), OpenRouter (`unrecognized field reasoning_content`), Anthropic (`Field \"presence_penalty\" invalid`). Without this, the reactive self-heal silently never fired on the most common upstream error shapes.
- **Verified the full retry chain end-to-end.** Six integration tests run the real `DefaultExecutor.execute()` flow with `proxyAwareFetch` mocked at the network boundary: 400 → `findOffendingField` matches → `delete sourceBody[offendingField]` → real `transformRequest` → real retry fetch → 200 returned. Tests confirm other body fields (temperature, messages, max_tokens) survive intact, unknown field names skip the retry (allowlist gating works), plain 400s with no field name don't retry, and a retry that ALSO 400s doesn't infinite-loop.

## Dashboard console-log noise filter
- The in-memory buffer that powers `/dashboard/console-log` was capturing every Next.js HTTP access line (`GET /api/version 200 in Xms`, `GET /api/settings ...`, `GET /manifest.webmanifest`, even the SSE stream that delivers the logs back to the UI). The dashboard's own polling flooded the buffer at ~1-2 req/sec and evicted real chat / auth / error traces via the maxLines cap. New `isAccessLogNoise()` filter drops the framework's specific access-log shape only when the path matches a known polling endpoint and the status is 2xx/3xx. Preserves everything that matters: any 4xx/5xx, all `[LEVEL]` tagged lines, POST/DELETE/PUT requests, Next.js startup banner, unknown future routes. Original stdout to the terminal is unchanged — only the dashboard buffer is filtered.

## Test counts
- Pre-release baseline: 947 passing / 20 expected-fail / 21 skipped (988 total)
- Post-release: 983 passing / 20 expected-fail / 21 skipped (1024 total)
- +36 new tests across 3 new test files: `cache-stickiness.test.js`, `console-log-filter.test.js`, `model-strip-reactive-retry.test.js`
- Zero regressions

## Intentionally NOT in this release
- Combo intelligence wiring (Tier 2.B) — deferred. The wiring would have `intentClassifier` + `complexityRouter` outputs change combo slot selection per request. User chose to skip rather than risk disrupting working combo behavior.
- Claude Code obfuscation stack (8 files in OmniRoute) — only worth porting if direct Anthropic accounts start getting throttled or you sign up for `anthropic-compatible-cc-*` reseller endpoints. Today's traffic routes through Claude direct (passthrough) and Antigravity (already obfuscated).
- Full compression framework port (29 files in OmniRoute) — existing RTK works. Marginal gain not worth the 20-40 hour port cost.

---

# v0.5.14 (2026-06-21) — Combo fallback speed + MITM stability + Auth loop fixes

Four major fixes addressing live user reports. Combos are now up to 15x
faster when hitting exhausted accounts, MITM restart loops are eliminated,
and live-fetch models correctly surface for free providers.

## Performance
- **Fast-fail combo routing for dead accounts (<1s vs 25s)**. Combos hitting
  multiple exhausted accounts (e.g. 403 "Verify your account" or 429 quota
  with long reset times) used to take 25+ seconds to fail over to a healthy
  provider due to pointless token refreshes and exponential backoff.
  - **Fix A (Token Refresh Skip):** `chatCore.js` now peeks at 403 bodies.
    If it sees "verify your account" / "permission_denied", it skips the
    OAuth token refresh entirely. Saves ~3s per dead account.
  - **Fix B (Pre-emptive 429 Parse):** `base.js` executor now checks the
    provider's `RetryInfo` *before* initiating exponential backoff. If the
    reset is >60s away, it skips the 14s retry loop and fails instantly.
    Saves ~14s per exhausted account.
  Result: A combo hitting 3 dead accounts now falls over to a healthy model
  in under 1 second. Applies to ALL providers and ALL combo strategies.

## Bug fixes
- **Infinite MITM restart loop eliminated.** Toggling MITM off/on could race
  with a queued background restart, causing an infinite loop of `Restart
  attempt 1/5 failed: MITM server is already running` every 5 seconds. Added
  a strict `!serverProcess.killed` guard to `scheduleMitmRestart()` to quietly
  drop stale restart requests.
- **Actionable 403 "Verify your account" dashboard links.** When Google flags
  an Antigravity account, kRouter now uses regex to extract the exact Google
  verification URL from the 403 body. The dashboard Connection card now
  displays `Verify your account: https://...` as a clickable link instead of
  raw truncated JSON.
- **Claude OAuth + Live Fetch Anti-Loop.** If Claude Desktop MITM was enabled,
  kRouter's own internal requests to `api.anthropic.com` (OAuth token exchange
  and provider model fetching) would hit its own MITM proxy and fail with
  `SELF_SIGNED_CERT_IN_CHAIN`. All internal OAuth and model fetches now pass
  the `x-request-source: local` header, bypassing the MITM intercept.
- **Live-fetch for free/passthrough providers (Issue 2).** Users with ONLY
  free providers (MiMo Free, OpenCode Free, OpenRouter, etc.) saw the "Select
  Model" modal open completely blank. `ModelSelectModal` now kicks off
  parallel background fetches to `/api/models/live` when opened, populating
  the dropdowns instantly. Includes 5-min LRU cache and inline retry buttons.

## Verified
- Full test suite: 605 pass / 20 expected-fail / 27 fail (baseline maintained)
- Combo fast-fail logic unit-tested against real provider error bodies
- MITM anti-loop tested live via Claude Desktop

# v0.5.13 (2026-06-20) — Linux GUI launcher coverage for MITM cert trust

## Bug fix

### Linux: NODE_EXTRA_CA_CERTS now reaches GUI-launched Antigravity / Claude Desktop / VS Code

Symptom (Ubuntu user, post-0.5.12):
  Even after kRouter auto-wrote NODE_EXTRA_CA_CERTS to ~/.profile,
  ~/.bashrc, ~/.zshrc in 0.5.12, GUI-launched Antigravity STILL rejected
  the MITM cert and forced the user to fall back to
    NODE_TLS_REJECT_UNAUTHORIZED=0 antigravity
  (which disables ALL TLS verification — insecure).

Root cause:
  Linux GUI launchers (GNOME Activities, KDE menu, .desktop files,
  desktop shortcuts) do NOT source shell rc files. They go through
  systemd-user / gnome-session, which only reads:
    - ~/.config/environment.d/*.conf  (systemd-user env)
    - ~/.pam_environment              (legacy PAM, deprecated but works)
    - /etc/environment                (system-wide, needs root)
  Our 0.5.12 fix only covered shell rc files → terminal-launched IDE
  worked, menu-launched IDE didn't.

Fix:
  Extended src/mitm/linuxNodeCaCerts.js to also write:
    ~/.config/environment.d/95-krouter.conf   (systemd-user, KEY=VALUE format)
    ~/.pam_environment                         (PAM, KEY DEFAULT=value format)
  in addition to the existing 4 shell rc files. 95- prefix sorts late
  so kRouter overrides earlier defaults (00-99 priority convention).
  PAM block uses BEGIN/END markers like the shell files so we can strip
  cleanly on uninstall without touching user-added PAM entries.

  src/mitm/manager.js log line updated to surface both reload paths:
    [linux-node-ca] Terminal-launched IDE: open a NEW terminal OR run: source ~/.profile
    [linux-node-ca] Menu-launched IDE (GNOME / KDE Activities, .desktop): log out + back in
                    OR run: systemctl --user daemon-reload && systemctl --user import-environment

Effect on Ubuntu user:
  Before 0.5.13: GUI Antigravity rejects MITM cert -> NODE_TLS_REJECT_UNAUTHORIZED=0 workaround
  After 0.5.13:  GUI Antigravity -> systemd-user reads 95-krouter.conf ->
                 NODE_EXTRA_CA_CERTS set -> cert accepted -> MITM works.

  User must log out + back in once (or systemctl --user reload) for
  systemd-user to re-read environment.d after the upgrade.

Verified (mocked-Linux unit tests, 17/17 PASS):
  - 5 files written on first set (.profile, .bashrc, .zshrc, environment.d, pam_environment)
  - systemd file has correct KEY=VALUE format (no shell export syntax)
  - pam_environment uses correct KEY DEFAULT=value syntax
  - Idempotent: second set with same path = 0 files changed
  - Rotation: new cert path replaces all 5 surfaces in place
  - Unset: all 5 surfaces cleaned, user content preserved in shell rc files
  - systemd file fully removed (we own it); pam_environment removed when empty
  - Non-Linux platforms: early return, no-op

Plus regression: 605 pass / 20 expected-fail / 27 fail — identical baseline.

## Upgrade

    npm install -g @sifxprime/krouter@latest
    # Restart kRouter MITM (writes new env files)
    # Log out + back in once for systemd-user to pick up environment.d

# v0.5.12 (2026-06-20) — Claude Desktop MITM + account health + Linux trust + cert UI

## Features

### Claude Desktop app routing via MITM (new)
Adds DNS-hijack + TLS interception for `api.anthropic.com` so the
Anthropic Claude Desktop Electron app — which hardcodes the URL and
does NOT honor ANTHROPIC_BASE_URL — can be routed through kRouter.

Verified live: Claude Desktop chat works through kRouter with
`kr/auto` → Kiro routing. Token preview (/v1/messages/count_tokens)
and telemetry (/api/event_logging/v2/batch) both handled correctly.

Opt-in via Dashboard → MITM → Claude Desktop. Toggle MITM off to
revert instantly (api.anthropic.com removed from /etc/hosts).

Note: Claude Code CLI users do NOT need this — use ANTHROPIC_BASE_URL.

### Cert Install/Uninstall buttons in dashboard (USER3)
Self-service root certificate management. Replaces hand-running
`security add-trusted-cert` / `update-ca-certificates` / `certutil -addstore`.

New card on Dashboard → MITM shows current cert state and three buttons:
  - **Install / Reinstall Certificate** — label changes with state
  - **Uninstall**
  - **Remove Legacy 9router Cert** — appears automatically when
    `~/.9router/mitm/rootCA.crt` is detected on disk

Inline sudo password input on Mac/Linux when not cached. Windows uses
existing UAC. Auto-refreshes status after every action.

Verified end-to-end on dev machine: full uninstall → keychain check →
reinstall → keychain check cycle in 6.1s with cached sudo.

## Bug fixes

### Linux: NODE_EXTRA_CA_CERTS auto-write in shell rc files (USER1 + USER4)
Ubuntu Antigravity (and any other Electron/Node IDE) was rejecting the
kRouter MITM cert with `x509: certificate signed by unknown authority`
even after `update-ca-certificates` ran. Root cause: Node.js + Electron
read their OWN bundled Mozilla CA store, not the OS trust store. macOS
and Windows had auto-`launchctl setenv` / `setx` for this since 0.5.6
— Linux was missing the branch entirely (helper had been removed in the
0.5.10 standalone cleanup).

Fix: new `src/mitm/linuxNodeCaCerts.js` writes a guarded BEGIN/END
block exporting `NODE_EXTRA_CA_CERTS=<cert path>` to `~/.profile`,
`~/.bashrc`, `~/.zshrc`, and `~/.bash_profile` (only existing ones,
plus always-create `.profile`). Idempotent — re-running with the same
path is no-op; new path replaces in place. Stripped cleanly on MITM
stop. Wired into the existing `IS_MAC` / `IS_WIN` start/stop branches
in `src/mitm/manager.js`.

After install, log surfaces a clear notice:
```
[linux-node-ca] NODE_EXTRA_CA_CERTS written to 3 shell rc file(s): ~/.profile, ~/.bashrc, ~/.zshrc
[linux-node-ca] ⚠ Effective in NEW shells only — restart your IDE
                (Antigravity / Claude Desktop / VS Code) OR run: source ~/.profile
```

Verified with 10/10 mocked-Linux unit tests covering idempotency,
existing-content preservation, in-place block replacement, and clean
unset.

### Free / passthroughModels providers count as active (USER2)
Users with ONLY free providers connected (MiMo Free, OpenCode Free,
OpenRouter, Vercel AI Gateway, Grok Web — all `passthroughModels: true`)
saw the "Select Model" button disabled on every IDE / CLI tool card
and the MITM panel. Root cause: `hasActiveProviders()` gate checked
three conditions (hardcoded models > 0, OpenAI-compatible, Anthropic-
compatible) — all three false for passthrough providers because their
models fetch live from a remote URL, not from the hardcoded MODELS map.

Fix: added 4th OR clause `AI_PROVIDERS[provider]?.passthroughModels === true`
in both `MitmPageClient.js` and `ToolDetailClient.js` so passthrough
connections register as active. 5 providers now correctly unlocked.

### Antigravity 403 "Verify your account" — lock whole account for 1hr
When Google flags an Antigravity OAuth account for needing verification
(PERMISSION_DENIED, "Verify your account to continue"), kRouter was
locking only the specific model that errored. Since a flagged account
fails on ALL models, this caused 5+ wasted 403 requests per combo
cycle before reaching a healthy account.

Fix: new `accountLock: true` flag on `ERROR_RULES`. When matched,
writes `modelLock___all` (locks entire account) instead of per-model
lock. 1hr cooldown. Auto-clears after 1hr or on "Test connection" click.
Log now shows `WHOLE ACCOUNT locked for 3600s` vs `modelLock_X`.

### Anti-loop header on ALL outbound Anthropic calls
Every kRouter-initiated call to `api.anthropic.com` now includes
`x-request-source: local` so the MITM server passes them through to
real Anthropic instead of intercepting (infinite loop prevention).
Previously only the Antigravity quota endpoints had this header. Fixed
in `open-sse/executors/base.js buildHeaders()` (covers all providers),
`claudeAutoPing.js sendPing()`, and 3 call sites in
`open-sse/services/usage.js`.

## Verified
- Claude Desktop MITM live on Mac — HTTP 200, 11.2s, routes via `kr/auto`
- USER2 fix: 5 passthroughModels providers verified, dashboard renders 200
- USER3 fix: full uninstall → keychain verify → reinstall → keychain verify
  cycle live on dev machine (6.1s with cached sudo)
- USER1 + USER4 fix: 10/10 mocked-Linux unit tests pass (idempotency,
  preservation, replacement, unset)
- 403 verify-account: 4/4 unit tests pass
- Full test suite: 605 pass + 20 expected-fail + 27 fail (baseline)

## Upgrade
```
npm install -g @sifxprime/krouter@latest
```
No data migration. Existing MITM cert, OAuth tokens, settings preserved.


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