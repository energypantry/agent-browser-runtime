# Agent Browser Runtime

Agent Browser Runtime is a compose-managed real Chrome runtime for AI agents. It gives each agent a leased Chrome Tab Group, a persistent browser profile, noVNC human handoff, artifact capture, extractor jobs, humanized pacing, and an explicit browser-consistency layer.

The point is simple: agents work through a shared, visible browser runtime instead of fighting over ad hoc headless sessions.

## What is included

- Broker: Node/Fastify HTTP + WebSocket control plane for leases, jobs, artifacts, pacing, and state.
- Browser runtime: Chromium/Chrome in Docker with CDP, Xvfb, x11vnc, noVNC, and a persistent profile mount.
- Companion extension: Chrome extension that owns real tabs, real Tab Groups, debugger/CDP calls, screenshots, HTML capture, session probes, and humanized primitives.
- CLI: `./cli/brs.js` for status, fetch, session probes, extractor jobs, artifacts, and leases.
- Skills: Codex and OpenClaw compatible skill folders under `skills/`.
- Examples: generic extractor examples only. Site-specific/private extractors are intentionally out of tree.

## Quick start

```bash
cp .env.example .env
docker compose up --build -d
./scripts/smoke-test.sh
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

Expected outputs: broker status, HTML artifact, screenshot artifact, and a real Chrome Tab Group visible in noVNC.

`./cli/brs.js status` also reports `stealth.enabled`, fingerprint header/patch toggles, and whether the optional TLS gateway proxy is configured.
It now also reports the loaded runtime fingerprint summary from the extension, including generated UA family, UA-CH header keys, platform, WebGL, and hardware-surface values.
The `BRS_*` environment prefix is kept as the stable Browser Runtime Service config surface.

## Anti-bot and browser-consistency stack

Agent Browser Runtime does not hide what it is doing. The runtime has a default-on anti-bot/risk-control compatibility layer so browser automation looks internally coherent across launch args, request headers, JS-visible surfaces, pacing, and manual handoff.

- Real browser runtime instead of pure headless fetches.
- Persistent Chrome profile for login-state reuse, cookies, localStorage, and extension state.
- noVNC human handoff for login, Captcha, slider, MFA, and account-safety checkpoints.
- Real Chrome Tab Groups so concurrent agents have visible, lease-scoped workspaces.
- Seed-based fingerprint generation: user agent, UA-CH, Accept-Language, platform, WebGL, hardware concurrency, device memory, and touch points move together.
- CDP header and emulation overrides before navigation: UA/UA-CH, locale, timezone, Accept-Language, and optional extra headers.
- Main-world stealth patching at `document_start`: webdriver, languages, platform, vendor, plugins/mimeTypes, Chrome runtime stubs, permissions, media codecs, WebGL, canvas, and audio surfaces.
- Canvas/audio noise controls and explicit WebGL/user-agent/platform overrides for compatibility testing.
- Platform cooldowns plus per-job humanized warmup, mousemove, scroll, and pause primitives.
- Optional proxy/TLS-gateway integration with QUIC disabled on the proxied path and health/stats surfacing in `status`.
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

## Extractor smoke

```bash
./cli/brs.js extract example.extract.js https://example.com --agent demo-agent --task extractor-smoke --screenshot --save-html
```

Default host CDP port is `19223` to avoid conflicts with other local browser services.

## Open-source boundary

The repository is designed to be publishable as a generic runtime package:

- Tracked: runtime code, docs, generic extractor examples, `.env.example`, and agent skills.
- Ignored: `.env`, SQLite state, artifacts, screenshots, traces, and persisted Chrome profile data.
- Excluded: private site extractors, customer/project-specific workflows, account cookies, credentials, and harvested content.

## Files

- `docs/SPEC.md` — architecture and API spec
- `docker-compose.yml` — broker + chrome-runtime
- `broker/` — HTTP/WS control plane
- `extension/` — Chrome companion extension for real Tab Groups + debugger CDP
- `runtime/chrome/` — Chromium + noVNC container
- `cli/brs.js` — small operator/client CLI
- `scripts/smoke-test.sh` — full local runtime regression test
- `extractors/` — generic extractor scripts with optional params schema
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
