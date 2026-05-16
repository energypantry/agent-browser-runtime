---
name: browser-runtime-skill
description: Use a compose-managed real Chrome runtime with persistent profile, noVNC handoff, real Tab Groups, leases, extractor jobs, default browser consistency policy, and runtime humanization for browser scraping or page exploration.
---

# browser-runtime-skill

Use this private skill when an agent needs a real, persistent browser runtime for scraping, exploration, login-state reuse, or extractor execution.

## Runtime

This skill expects the project stack to be running from `/Users/zhi/Desktop/Projects/browser-runtime-skill`:

```bash
docker compose up --build -d
./scripts/smoke-test.sh
```

Endpoints:

- Broker: `http://127.0.0.1:17890`
- CDP: `http://127.0.0.1:19223`
- noVNC: `http://127.0.0.1:16080/vnc.html?autoconnect=true&resize=remote`

## Operating model

- The browser runtime is long-running and compose-managed.
- Before starting work, run `./cli/brs.js status`; `extensionConnected: true` means the Chrome companion extension is ready.
- The broker waits briefly for extension reconnects, and the extension sends keepalives; if `extensionConnected` stays false, restart with `docker compose up --build -d`.
- Agents must use broker leases; do not directly fight over Chrome tabs.
- One lease maps to one real Chrome Tab Group.
- Broker persists state/artifacts and owns task-level pacing; the extension only executes Chrome-native browser operations, including scripting-based humanized mouse/scroll/pause actions.
- Browser consistency policy is default-on: a seed-based coherent fingerprint profile, UA/UA-CH headers, main-world stealth evasions, locale/timezone CDP overrides, and optional TLS gateway proxy support are configured through `BRS_*` env vars.
- `./cli/brs.js status` should show `stealth.enabled: true`, `stealth.fingerprint.generated: true`, `platformPacing`, and active TLS gateway health/stats fields when configured.
- Use `./cli/brs.js probe-session <platform>` to check persisted login/session state for `linkedin`, `reddit`, `facebook`, `instagram`, or `generic`; cookie values are omitted unless `--include-cookies` is passed, and full storage export requires `--include-storage-state`.
- Extractor retries should preserve the extractor's real error. A `No group with id` failure usually means the runtime needs the current bugfix version loaded.

## Quick commands

From the project root:

```bash
./cli/brs.js status
./cli/brs.js fetch https://example.com --agent vovo --task smoke --screenshot --humanize enhanced
./cli/brs.js probe-session linkedin --humanize off --cooldown false
./cli/brs.js extract example.extract.js https://example.com --agent vovo --task extractor-smoke --screenshot --save-html
./cli/brs.js acquire --agentId vovo --taskId research --domain example.com
./cli/brs.js open <leaseId> https://example.com
./cli/brs.js release <leaseId>
```

## Modes

1. `explore`: agent uses a leased tab group to understand a new site.
2. `record`: save selectors, screenshots, HTML, network hints, and failure states.
3. `run`: execute a stable extractor script in a leased workspace.

MVP implements `shared-context-tab-group`; use `dedicated-runtime` conceptually for risky targets that should not share profile/IP/session. Humanization profiles are `minimal`, `standard`, `enhanced`, or `off`; pass `--humanize <level>` per job or set `BOT_HUMANIZE_LEVEL`. Browser consistency profile defaults to `BRS_STEALTH_PROFILE=standard`.

## Safety

- Runtime profile, artifacts, and SQLite state are gitignored.
- Do not commit cookies, credentials, screenshots with secrets, or `.env`.
- If login/Captcha appears, use noVNC for manual handoff instead of trying to bypass it.
- Runtime upgrades preserve the persisted browser profile by default. Use `BRS_RESET_PROFILE_ON_SIGNATURE_CHANGE=1` only for an intentional profile wipe.
- `accounts.google.com` is excluded from default stealth/fingerprint patches because Google account and Chrome Sync flows are more sensitive to spoofed browser identity than normal collection targets.

## More detail

Read `docs/SPEC.md` for architecture/API specifics.
