# Agent Browser Runtime SPEC v0.1

## Goal

Provide a compose-managed, persistent real-browser runtime that multiple agents can share safely. Agents never control Chrome directly; they acquire a lease from the broker, receive a real Chrome Tab Group workspace, run exploration or extractor jobs, and release the lease.

## Design lineage

- Production browser-agent runtime patterns: Dockerized Chromium, CDP, noVNC, persistent profile, fingerprint/proxy/timezone launch contract, profile-signature reset, artifact retention, and humanized action primitives.
- Page-collection runtime patterns: explicit browser runtime contract, CDP readiness, humanize/pacing, and artifacts-on-failure discipline.
- ChromeForHermes prototype: `chrome.tabs.group`, `chrome.tabGroups.update`, `chrome.debugger.attach/sendCommand`, session-scoped tab groups.
- Companion-extension lesson: native Chrome Tab Groups are practical when implemented by a browser extension, not by raw Playwright alone.

## Deployment

Docker Compose owns the runtime:

```text
agent-browser-runtime
├─ tls-gateway     # startup-level browser proxy + health/stats
├─ broker          # HTTP/WS control plane, lease/job/artifacts/state
└─ chrome-runtime  # Chromium + noVNC + persistent profile + companion extension
```

Host bindings are loopback-only:

- Broker: `http://127.0.0.1:17890`
- CDP proxy: `http://127.0.0.1:19223`
- noVNC: `http://127.0.0.1:16080/vnc.html?autoconnect=true&resize=remote`

## Control plane responsibilities

### Broker

- Persist leases, tabs, jobs, and artifacts in SQLite.
- Accept agent requests over HTTP.
- Maintain a WebSocket JSON-RPC channel to the Chrome companion extension.
- Own TTL cleanup and release discipline.
- Write artifacts under `/artifacts` and return stable local paths.

### Companion extension

- Execute Chrome-only operations:
  - create real tabs
  - create/update real Tab Groups
  - attach Chrome debugger to background tabs
  - execute CDP commands
  - capture screenshot / HTML
  - execute humanized warmup, scroll, and pause primitives via `chrome.scripting` so background-tab timer throttling does not stall jobs
- Keep no durable business state. Broker is source of truth.

### Chrome runtime

- Keep persistent browser profile at `./runtime/profile`.
- Expose noVNC for manual login/Captcha handoff.
- Load companion extension from `./extension`.
- Generate `runtime-config.js` from `BRS_*` env vars before Chrome starts.

## Browser identity policy

The runtime defaults to `trusted-real-browser`: real browser surfaces, persistent profile, noVNC handoff, visible tab groups, pacing, and artifacts, without extension-level UA/header/WebGL/canvas/audio spoofing or startup-level timezone/AutomationControlled overrides. This baseline is intended for high-trust login, checkout, account-safety, and other sensitive flows where page-level spoofing can create cross-layer inconsistencies.

Default capabilities:

- `BRS_STEALTH_MODE=trusted-real-browser`: keep browser-visible identity native to the running browser and disable legacy JS/CDP stealth overrides.
- `BRS_GENERATE_FINGERPRINT_ENABLED=0`: do not generate or apply extension-level UA/UA-CH/WebGL/hardware profiles by default.
- `BRS_RUNTIME_PRESET=trusted-real-browser`: default identity preset for the real-browser baseline.
- `docker-compose.fingerprint.yml`: optional overlay that mounts a host `fingerprint-chromium` directory at `/opt/fingerprint-chromium`; when `chrome-wrapper` or `chrome` is present, Chromium startup uses that binary with `--fingerprint` and reports it through `status.browserRuntime`.
- `BRS_STEALTH_MODE=legacy-js`: opt into the previous extension-level compatibility layer. In this mode a generated identity can include user agent, UA-CH metadata and headers, `Accept-Language`, navigator platform, WebGL vendor/renderer, hardware concurrency, device memory, and touch points.
- `BRS_FINGERPRINT_HEADERS_ENABLED=1` in `legacy-js`: apply generated headers plus optional `BRS_EXTRA_HTTP_HEADERS_JSON` through CDP before first navigation.
- `BRS_FINGERPRINT_PATCHES_ENABLED=1` in `legacy-js`: inject `stealth-content.js` in the main world at `document_start`; evasions cover webdriver, languages, platform, vendor, plugins/mimeTypes, Chrome app/runtime stubs, media codecs, WebGL, canvas, and audio.
- `BROWSER_TIMEZONE` / `BRS_STEALTH_TIMEZONE`: applied only in `legacy-js` or `patched-browser`; the trusted default leaves browser timezone behavior native.
- `BRS_STEALTH_EXCLUDED_HOSTS=accounts.google.com,linkedin.com,www.linkedin.com,jd.com,www.jd.com,github.com,www.github.com`: skip legacy JS/CDP overrides for high-trust login hosts where a spoofed browser identity is more likely to hurt than help.
- `BRS_TLS_GATEWAY_ENABLED=0`: TLS gateway is present as an optional service, but the browser proxy path is opt-in to avoid transport/browser mismatches. When enabled, `BRS_TLS_GATEWAY_PROXY_SERVER` routes Chromium through the gateway and disables QUIC on that proxied path.
- `BOT_HUMANIZE_LEVEL` and per-job `--humanize`: task-level pacing, mousemove, scroll, and pauses.
- `BRS_PLATFORM_COOLDOWN_ENABLED=1`: platform-level cooldown defaults cover common high-friction social surfaces (`reddit=45s`, `facebook=60s`, `linkedin=180s`, `instagram=240s`, manual challenge `300s`).

Set `BRS_STEALTH_MODE=patched-browser` when a mounted browser binary owns identity changes at the browser/backend layer. In that mode the companion extension still avoids JS/CDP stealth injection.

Profile reset policy: `BOT_RUNTIME_SIGNATURE` changes no longer wipe the persisted browser profile by default. Set `BRS_RESET_PROFILE_ON_SIGNATURE_CHANGE=1` when you intentionally want a clean profile after changing low-level browser identity settings.

## Lease model

A lease represents one agent/task workspace.

Required fields:

- `id`
- `agentId`
- `taskId`
- `domain`
- `mode`: `shared-context-tab-group | isolated-context | dedicated-runtime`
- `chromeGroupId`
- `status`: `allocated | released | expired`
- `createdAt`, `expiresAt`

MVP supports `shared-context-tab-group` only. Other modes are reserved API-compatible future work.

## API v0

### `GET /health`

Returns broker and extension health.

### `GET /status`

Returns runtime endpoints, active leases, tabs, extension connection state, default humanization level, browser consistency policy status, sanitized runtime config loaded by the extension, and optional TLS gateway health/stats.
Also returns `platformPacing` with cooldown defaults and last action timestamps.

### `POST /leases`

Create a lease.

```json
{
  "agentId": "demo-agent",
  "taskId": "research-001",
  "domain": "example.com",
  "mode": "shared-context-tab-group",
  "ttlMs": 1800000
}
```

### `DELETE /leases/:id`

Release a lease. By default closes owned tabs unless `?closeTabs=false`.

### `POST /leases/:id/tabs`

Create a tab in the lease's real Chrome Tab Group.

```json
{ "url": "https://example.com", "title": "Example", "waitUntilCompleteMs": 10000 }
```

### `POST /tabs/:tabId/navigate`

Navigate an owned tab.

### `POST /tabs/:tabId/fetch-page`

Navigate an owned tab, capture HTML, and optionally capture a screenshot without allocating a new lease or Chrome Tab Group. This is the broker-level primitive for continuous same-site browsing sessions.

### `POST /tabs/:tabId/html`

Capture `document.documentElement.outerHTML` into an artifact.

### `POST /tabs/:tabId/screenshot`

Capture a JPEG/PNG screenshot into an artifact.

### Humanization policy

Task bodies can include `humanize` / `humanizePolicy` or the CLI flag `--humanize minimal|standard|enhanced|off`. The broker applies task-level pacing around open/navigate/html/screenshot; the companion extension executes low-level mousemove, wheel/scroll, and pause primitives. Defaults come from `BOT_HUMANIZE_LEVEL`. Avoid page-side `setTimeout` animation loops in background tabs; Chrome can throttle them heavily.

### Browser interaction discipline

This is a runtime contract for every target site. Direct navigation is reserved for initial entry to an exact user-provided URL, platform/session probes, or returning to a previously captured exact URL for inspection.

After entry, agents must complete site workflows through visible UI controls: keyboard input for search terms and forms, cursor movement before clicking, real clicks, scrolling, hover, pauses, and normal front-end state transitions. Search, filters, pagination, profile/result selection, login, checkout, and account-safety flows should not be replaced by synthesized destination/search URLs, querystring mutation, `location` jumps, dispatched DOM clicks, or backend/API shortcuts.

If a workflow needs a browser action that the broker/extension does not expose yet, use noVNC manual handoff or add a real browser primitive before automating that workflow.

### UI action primitives

The broker exposes first-class UI actions for site workflows after the initial entry URL. These actions execute through the companion extension and Chrome debugger input events rather than DOM click dispatch.

- `POST /tabs/:tabId/ui/move` with `{ "x": 320, "y": 240 }` or `{ "selector": "button" }`
- `POST /tabs/:tabId/ui/click` with `{ "selector": "button[type=submit]" }`, `{ "targetText": "Next" }`, or coordinates
- `POST /tabs/:tabId/ui/type` with `{ "selector": "input[name=q]", "text": "search terms" }`
- `POST /tabs/:tabId/ui/press` with `{ "key": "Enter" }`
- `POST /tabs/:tabId/ui/scroll` with `{ "direction": "down", "count": 2 }` or `{ "deltaY": 650 }`
- `POST /tabs/:tabId/ui/wait-for` with `{ "selector": ".result", "timeoutMs": 10000 }` or `{ "targetText": "Results" }`

Extractor scripts receive a tab-bound `ui` helper with the same actions: `ui.move`, `ui.click`, `ui.type`, `ui.press`, `ui.scroll`, and `ui.waitFor`. They also receive `ui.html()` and `ui.screenshot()` helpers for post-interaction evidence capture.

### `POST /jobs/fetch-page`

One-shot workflow for smoke tests and isolated page evidence:

1. acquire lease
2. create grouped tab
3. navigate/wait
4. capture HTML and optional screenshot
5. optionally release/close

For multi-page exploration within one site or one user task, reuse a lease/tab with `POST /tabs/:tabId/fetch-page` or the CLI `browse-*` commands instead of issuing repeated one-shot fetch jobs.

### `POST /sessions/probe`

One-shot platform session probe:

1. acquire lease
2. open the platform URL in a grouped tab
3. optionally humanize
4. inspect cookies through CDP and lightweight page/login/challenge signals
5. write a `session-probe` artifact
6. optionally save HTML/screenshot and optionally keep the tab open

Supported platform policies: `linkedin`, `reddit`, `facebook`, `instagram`, and `generic`.

```json
{
  "platform": "linkedin",
  "url": "https://www.linkedin.com/feed/",
  "includeCookies": false,
  "includeStorageState": false,
  "cooldown": true,
  "saveHtml": false,
  "screenshot": false,
  "humanize": "off"
}
```

Returns `connected`, `reason`, `errorCode`, auth cookie names, cookie expiry, current URL, and page signals. Cookie values are omitted unless `includeCookies=true`.
Set `includeStorageState=true` to export cookies plus local/session storage values for the current origin. This is sensitive and should not be committed.

### `GET /jobs` / `GET /jobs/:id`

Expose recent jobs plus job logs and related artifacts for internal observability.

### Artifact management

`GET /artifacts`, `GET /artifacts/:id`, `GET /artifacts/:id/download`, `DELETE /artifacts/:id`, and `POST /artifacts/cleanup` make evidence discoverable and cleanable without shelling into directories. Cleanup is dry-run by default.

### `POST /jobs/extract`

Runs `/extractors/<name>.extract.js`; extractor must export `extract({ url, finalUrl, pageHtml, tab, ui, params, attempt })`. It may export `schema` / `paramsSchema` for simple params validation. Broker supports `maxAttempts` / `retries` and writes `error` artifacts on failed attempts. The broker writes a JSON result artifact and can optionally save HTML/screenshot artifacts.

CLI:

```bash
./cli/brs.js extract example.extract.js https://example.com --agent demo-agent --task extractor-smoke --screenshot --save-html
```

## Extension JSON-RPC

Broker sends:

```json
{ "jsonrpc": "2.0", "id": 1, "method": "tabs.create", "params": {} }
```

Extension replies:

```json
{ "jsonrpc": "2.0", "id": 1, "result": {} }
```

Errors use JSON-RPC style `{ error: { code, message } }`.

## Artifact policy

Artifacts live outside git:

```text
artifacts/YYYY-MM-DD/<leaseId>/<kind>-<timestamp>.<ext>
```

Never store credentials or raw secrets intentionally. Site extractors should redact outputs before returning user-facing summaries.

## MVP acceptance test

Preferred full regression test:

```bash
cp .env.example .env
./scripts/smoke-test.sh
```

Manual equivalent:

```bash
cp .env.example .env
docker compose up --build -d
./cli/brs.js status
./cli/brs.js fetch https://example.com --agent demo-agent --task smoke --screenshot --humanize enhanced
./cli/brs.js browse-start https://example.com --agent demo-agent --task research
./cli/brs.js browse-nav <leaseId> <tabId> https://example.com/page-2 --screenshot
./cli/brs.js browse-end <leaseId>
```

Expected:

- broker healthy
- extension connected
- `status.humanize.level` is present
- `status.stealth.mode` is `trusted-real-browser`
- `status.stealth.enabled` is false by default
- a real Chrome Tab Group appears in noVNC
- HTML artifact exists
- screenshot artifact exists
- release closes the tab unless `--keep-open`
- extractor smoke returns `Example Domain` from `example.extract.js`
- leased open/release creates a real grouped tab and closes it on release
