# Agent Browser Runtime

Agent Browser Runtime is a compose-managed real Chrome runtime for AI agents. It gives each agent a leased Chrome Tab Group, a persistent browser profile, noVNC human handoff, artifact capture, extractor jobs, humanized pacing, and an explicit browser-consistency layer.

The point is simple: agents work through a shared, visible browser runtime instead of fighting over ad hoc headless sessions.

## Responsible use only

This project is published only for learning, research, and responsible technical exploration.

You must comply with applicable laws, platform terms, privacy rules, account-safety boundaries, and rate-limit or access-control policies. Do not use Agent Browser Runtime for illegal activity, unauthorized access, credential or session abuse, privacy-invasive collection, spam, fraud, harassment, or any attempt to harm, overload, or disrupt a service.

If a target requires login, consent, payment, Captcha, MFA, or another human/account-safety checkpoint, use manual handoff and respect the outcome.

## License and commercial use

Agent Browser Runtime is source-available under the PolyForm Noncommercial License 1.0.0. Noncommercial learning, research, experimentation, and responsible technical exploration are permitted under the license terms.

Commercial use, resale, commercial hosted service use, paid product integration, or use primarily intended to support commercial activity requires a separate written commercial license from the repository owner or copyright holder.

## What is included

- Broker: Node/Fastify HTTP + WebSocket control plane for leases, jobs, artifacts, pacing, and state.
- Browser runtime: Chromium/Chrome in Docker with CDP, Xvfb, x11vnc, noVNC, and a persistent profile mount.
- TLS gateway: local HTTP proxy service wired into Chromium at launch time, with gateway health/stats surfaced by the broker.
- Companion extension: Chrome extension that owns real tabs, real Tab Groups, debugger/CDP calls, screenshots, HTML capture, session probes, humanized primitives, and real UI action primitives.
- CLI: `./cli/brs.js` for status, fetch, session probes, extractor jobs, artifacts, and leases.
- Skills: Codex and OpenClaw compatible skill folders under `skills/`.
- Examples: generic extractors plus public platform extractor examples. Private/internal extractors are intentionally out of tree.

## Quick start

```bash
cp .env.example .env
docker compose up --build -d
./scripts/smoke-test.sh
```

To enable a mounted `fingerprint-chromium` binary, set `BRS_FINGERPRINT_CHROMIUM_HOST_PATH` to a host directory containing `chrome-wrapper` or `chrome`, then start with the overlay:

```bash
docker compose -f docker-compose.yml -f docker-compose.fingerprint.yml up --build -d
```

Open noVNC when a login, challenge, or manual inspection is needed:

```bash
open 'http://127.0.0.1:16080/vnc.html?autoconnect=true&resize=remote'
```

Quick manual checks:

```bash
./cli/brs.js status
./cli/brs.js fetch https://example.com --agent demo-agent --task smoke --screenshot --humanize enhanced
```

Expected outputs: broker status, TLS gateway health, HTML artifact, screenshot artifact, and a real Chrome Tab Group visible in noVNC.

`./cli/brs.js status` also reports `stealth.enabled`, fingerprint header/patch toggles, and whether the startup-level TLS gateway proxy is configured and active.
The default runtime preset is `chrome124-macos`, which aligns the browser identity around a Chrome 124 macOS profile to match the bundled TLS gateway profile. This preset applies to regular browser work across sites unless an environment override changes it. When the fingerprint overlay is used, `status.browserRuntime.fingerprintChromium.active` reports whether the mounted binary was actually selected.
It now also reports the loaded runtime fingerprint summary from the extension, including generated UA family, UA-CH header keys, platform, WebGL, and hardware-surface values.
The `BRS_*` environment prefix is kept as the stable Browser Runtime Service config surface.

## Anti-bot and browser-consistency stack

The runtime has a default-on anti-bot/risk-control compatibility layer so browser automation looks internally coherent across launch args, request headers, JS-visible surfaces, pacing, and manual handoff.

- Real browser runtime instead of pure headless fetches.
- Persistent Chrome profile for login-state reuse, cookies, localStorage, and extension state.
- noVNC human handoff for login, Captcha, slider, MFA, and account-safety checkpoints.
- Real Chrome Tab Groups so concurrent agents have visible, lease-scoped workspaces.
- Seed-based fingerprint generation: user agent, UA-CH, Accept-Language, platform, WebGL, hardware concurrency, device memory, and touch points move together.
- CDP header and emulation overrides before navigation: UA/UA-CH, locale, timezone, Accept-Language, and optional extra headers.
- Main-world stealth patching at `document_start`: webdriver, languages, platform, vendor, plugins/mimeTypes, Chrome runtime stubs, permissions, media codecs, WebGL, canvas, and audio surfaces.
- Canvas/audio noise controls and explicit WebGL/user-agent/platform overrides for compatibility testing.
- Platform cooldowns plus per-job humanized warmup, mousemove, scroll, and pause primitives.
- All-site browser interaction discipline: after the initial exact URL/probe entry point, agents must complete workflows through visible UI controls with keyboard input, cursor movement/clicking, scrolling, hover, and pauses instead of synthesized URL jumps, querystring shortcuts, DOM-click dispatch, or backend/API shortcuts.
- Runtime UI action primitives exposed through `/tabs/:tabId/ui/*` and extractor `ui` helpers: `move`, `click`, `type`, `press`, `scroll`, and `waitFor`.
- Startup-level proxy/TLS-gateway integration with QUIC disabled on the proxied path and health/stats surfacing in `status`.
- High-trust login-host exclusions through `BRS_STEALTH_EXCLUDED_HOSTS`; `accounts.google.com` is excluded by default because spoofing can harm account login flows.

This is compatibility infrastructure for legitimate real-browser agent work, not a promise that any platform will accept automation. Use noVNC for login, Captcha, slider, or account-safety handoff.
Runtime upgrades preserve the persisted browser profile by default; set `BRS_RESET_PROFILE_ON_SIGNATURE_CHANGE=1` only when you intentionally want to wipe cookies/profile state after a signature change.

## Session probes

Use the shared probe endpoint to check whether a persisted browser profile still looks logged in on a platform:

```bash
./cli/brs.js probe-session linkedin --humanize off
./cli/brs.js probe-session reddit --screenshot --save-html
```

The probe writes a `session-probe` artifact and returns `connected`, `reason`, `errorCode`, auth cookie names, expiry, current URL, and lightweight page signals. Cookie values are omitted unless `--include-cookies` is passed.
Use `--include-storage-state` only when you intentionally need a Playwright-style export with cookie and storage values. Platform cooldowns are enabled by default (`reddit=45s`, `facebook=60s`, `linkedin=180s`, `instagram=240s`) and can be bypassed per probe with `--cooldown false`.

## Platform extractors

```bash
./cli/brs.js extract example.extract.js https://example.com --agent demo-agent --task extractor-smoke --screenshot --save-html
```

The repository ships extractor scripts under `extractors/` to show how stable site workflows can be packaged behind the broker job API. Extractors export an optional params schema plus `extract({ url, finalUrl, pageHtml, tab, ui, params, attempt })`, and can use the runtime's real UI helpers before reading fresh HTML.

Current examples:

- `example.extract.js` — minimal HTML/title extraction smoke test.
- `failing.extract.js` — intentional failure fixture for retry and error artifacts.
- `reddit.extract.js` — public Reddit platform example. Feed URLs return thread summaries; thread URLs return post text plus visible comments, with optional UI-driven comment expansion.

Example Reddit feed run:

```bash
./cli/brs.js extract reddit.extract.js 'https://www.reddit.com/r/<subreddit>/new/' \
  --agent demo-agent \
  --task reddit-feed \
  --params '{"mode":"feed","limit":10,"sinceHours":72,"maxFeedScrolls":8}' \
  --screenshot \
  --save-html
```

Example Reddit thread run:

```bash
./cli/brs.js extract reddit.extract.js 'https://www.reddit.com/r/<subreddit>/comments/<thread_id>/<slug>/' \
  --agent demo-agent \
  --task reddit-thread \
  --params '{"mode":"thread","expandComments":true,"maxCommentExpansionRounds":8,"maxCommentExpansionClicks":4}'
```

The Reddit extractor works from the browser-rendered page HTML and broker UI primitives; it does not use Reddit JSON/API endpoints and does not contain credentials, cookies, local paths, or a fixed subreddit list.

### Reddit validation snapshot

A representative local validation run used the runtime with persisted login state and conservative pacing against a 30-subreddit Reddit collection set. The collector stored output outside this repository; the numbers below are aggregate counts only.

Snapshot time: `2026-05-20T01:10:54Z`

| Metric | Result |
| --- | ---: |
| Continuous validation window | 95.8 hours |
| Completed batches | 25 |
| Historical bootstrap batches | 1 |
| Realtime update batches | 24 |
| Persisted Reddit threads | 5,880 |
| Persisted Reddit comments | 55,190 |
| Subreddit sources with persisted threads | 28 |
| Bootstrap evidence rows | 4,405 |
| Realtime evidence rows | 2,481 |
| Latest completed realtime batch duration | 2.1 hours |
| Latest completed realtime batch evidence rows | 97 |

This snapshot is a functional validation result, not a throughput guarantee. Runtime speed depends on platform state, account state, cooldown policy, UI expansion depth, network conditions, and manual handoff events.

Default host CDP port is `19223` to avoid conflicts with other local browser services.

## Files

- `docs/SPEC.md` — architecture and API spec
- `docker-compose.yml` — tls-gateway + broker + chrome-runtime
- `docker-compose.fingerprint.yml` — optional fingerprint-chromium mount overlay
- `broker/` — HTTP/WS control plane
- `extension/` — Chrome companion extension for real Tab Groups + debugger CDP
- `runtime/chrome/` — Chromium + noVNC container
- `tls-gateway/` — local gateway service used by Chromium's startup proxy path
- `cli/brs.js` — small operator/client CLI
- `scripts/smoke-test.sh` — full local runtime regression test
- `extractors/` — generic and platform extractor scripts with optional params schema
- `skills/codex/agent-browser-runtime/` — Codex skill for using the runtime
- `skills/codex/agent-browser-runtime-deploy/` — Codex skill for deploying/verifying the runtime
- `skills/openclaw/agent-browser-runtime/` — OpenClaw-compatible skill for using the runtime
- `skills/openclaw/agent-browser-runtime-deploy/` — OpenClaw-compatible skill for deploying/verifying the runtime
- `data/`, `artifacts/`, `runtime/profile/` — runtime state, gitignored

## Operator APIs

```bash
./cli/brs.js jobs
./cli/brs.js job <jobId>
./cli/brs.js artifacts --leaseId <leaseId>
./cli/brs.js artifact <artifactId>
./cli/brs.js artifact-download <artifactId> /tmp/result.json
./cli/brs.js cleanup-artifacts --olderThanDays 7
```

Extractors may export `schema` / `paramsSchema`; pass params with `--params '{"includeLength":true}'`. Use `--max-attempts 2` or `--retries 1` for retry. Failed extractor attempts write `error` artifacts for debugging.
