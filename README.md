# browser-runtime-skill

Compose-managed shared real-browser runtime for agents, with persistent profile, noVNC handoff, leases, artifacts, humanized pacing, and a default browser consistency policy.

## Start

```bash
cp .env.example .env
docker compose up --build -d
```

## Smoke test

Full runtime smoke test:

```bash
./scripts/smoke-test.sh
```

It validates compose config/startup, broker/extension connection, humanized fetch, extractor execution, params schema, retry/error artifacts, job/artifact APIs, real Tab Group open/release, and artifact file sizes.

Quick manual checks:

```bash
./cli/brs.js status
./cli/brs.js fetch https://example.com --agent vovo --task smoke --screenshot --humanize enhanced
```

Expected outputs: broker status, HTML artifact, screenshot artifact, and a real Chrome Tab Group visible in noVNC.

`./cli/brs.js status` also reports `stealth.enabled`, fingerprint header/patch toggles, and whether the optional TLS gateway proxy is configured.
It now also reports the loaded runtime fingerprint summary from the extension, including generated UA family, UA-CH header keys, platform, WebGL, and hardware-surface values.

## Browser consistency policy

The runtime now treats stealth/fingerprint behavior as a default-on policy layer:

- extension content script patches common browser-surface signals at `document_start`, including webdriver, languages, platform, vendor, plugins/mimeTypes, Chrome app/runtime stubs, media codecs, WebGL, canvas, and audio
- high-trust login domains can be excluded from the consistency layer with `BRS_STEALTH_EXCLUDED_HOSTS`; `accounts.google.com` is excluded by default
- CDP applies `Accept-Language`, UA/UA-CH metadata, extra headers, locale, and timezone before first real navigation
- launch config generates a coherent seed-based browser profile by default: user agent, UA-CH, Accept-Language, platform, WebGL, hardware concurrency, device memory, and touch-points move together
- Chrome version is detected from the runtime binary by default; set `BRS_CHROME_MAJOR` or `BRS_CHROME_FULL_VERSION` only when you intentionally need a pinned advertised version
- explicit `BRS_USER_AGENT`, `BRS_PLATFORM`, `BRS_WEBGL_VENDOR`, `BRS_WEBGL_RENDERER`, and `BRS_EXTRA_HTTP_HEADERS_JSON` values still override or extend the generated profile
- humanized pacing remains enabled through `BOT_HUMANIZE_LEVEL` or `--humanize`
- TLS gateway support is enabled as a capability, becomes active when `BRS_TLS_GATEWAY_PROXY_SERVER` is set, adds Chromium proxy args with QUIC disabled, and can expose `/health` and `/stats` through `./cli/brs.js status`

This is compatibility infrastructure for real-browser agent work, not a guarantee that any platform will accept automation. Use noVNC for login, Captcha, slider, or account-safety handoff.
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
./cli/brs.js extract example.extract.js https://example.com --agent vovo --task extractor-smoke --screenshot --save-html
```

Default host CDP port is `19223` to avoid conflicts with other local browser services.

## Files

- `docs/SPEC.md` — architecture and API spec
- `docker-compose.yml` — broker + chrome-runtime
- `broker/` — HTTP/WS control plane
- `extension/` — Chrome companion extension for real Tab Groups + debugger CDP
- `runtime/chrome/` — Chromium + noVNC container
- `cli/brs.js` — small operator/client CLI
- `scripts/smoke-test.sh` — full local runtime regression test
- `extractors/` — site extractor scripts with optional params schema
- `data/`, `artifacts/`, `runtime/profile/` — runtime state, gitignored

## Internal product APIs

```bash
./cli/brs.js jobs
./cli/brs.js job <jobId>
./cli/brs.js artifacts --leaseId <leaseId>
./cli/brs.js artifact <artifactId>
./cli/brs.js artifact-download <artifactId> /tmp/result.json
./cli/brs.js cleanup-artifacts --olderThanDays 7
```

Extractors may export `schema` / `paramsSchema`; pass params with `--params '{"includeLength":true}'`. Use `--max-attempts 2` or `--retries 1` for retry. Failed extractor attempts write `error` artifacts for debugging.
