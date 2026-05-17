---
name: agent-browser-runtime
description: Use Agent Browser Runtime, a compose-managed real Chrome runtime with persistent profile, noVNC handoff, real Tab Groups, leases, extractor jobs, default browser consistency policy, and runtime humanization for browser scraping or page exploration.
---

# Agent Browser Runtime

Use this skill when an agent needs a real, persistent browser runtime for page exploration, login-state reuse, screenshot/HTML evidence, session probes, or extractor execution.

## Runtime

This skill expects the project stack to be running from the Agent Browser Runtime repository root:

```bash
cp .env.example .env
docker compose up --build -d
./scripts/smoke-test.sh
```

Endpoints:

- Broker: `http://127.0.0.1:17890`
- CDP: `http://127.0.0.1:19223`
- noVNC: `http://127.0.0.1:16080/vnc.html?autoconnect=true&resize=remote`

## Operating Model

- The browser runtime is long-running and compose-managed.
- Before starting work, run `./cli/brs.js status`; `extensionConnected: true` means the Chrome companion extension is ready.
- If `extensionConnected` stays false, restart with `docker compose up --build -d`.
- Agents must use broker leases; one lease maps to one real Chrome Tab Group.
- Broker persists state/artifacts and owns task-level pacing; the extension executes Chrome-native browser operations, including scripted humanized mouse/scroll/pause actions.
- Browser consistency policy is default-on: seed-based fingerprint profile, UA/UA-CH headers, main-world stealth evasions, locale/timezone CDP overrides, and optional TLS gateway proxy support through `BRS_*` env vars.
- `./cli/brs.js status` should show `stealth.enabled: true`, `stealth.fingerprint.generated: true`, and `platformPacing`.
- Keep at least 70 ms between broker-driven browser requests. For unknown or sensitive platforms, serialize per target site and use seconds-to-minutes cooldowns.
- Use `./cli/brs.js probe-session <platform>` to check persisted login/session state for `linkedin`, `reddit`, `facebook`, `instagram`, or `generic`; cookie values are omitted unless `--include-cookies` is passed.

## Quick Commands

From the project root:

```bash
./cli/brs.js status
./cli/brs.js fetch https://example.com --agent demo-agent --task smoke --screenshot --humanize enhanced
./cli/brs.js probe-session linkedin --humanize off --cooldown false
./cli/brs.js extract example.extract.js https://example.com --agent demo-agent --task extractor-smoke --screenshot --save-html
./cli/brs.js acquire --agentId demo-agent --taskId research --domain example.com
./cli/brs.js open <leaseId> https://example.com
./cli/brs.js release <leaseId>
```

## Modes

1. `explore`: agent uses a leased tab group to understand a new site.
2. `record`: save selectors, screenshots, HTML, network hints, and failure states.
3. `run`: execute a stable extractor script in a leased workspace.

MVP implements `shared-context-tab-group`. Use `dedicated-runtime` conceptually for risky targets that should not share profile/IP/session. Humanization profiles are `minimal`, `standard`, `enhanced`, or `off`.

## Safety

- Runtime profile, artifacts, and SQLite state are gitignored.
- Do not commit cookies, credentials, screenshots with secrets, raw harvested content, or `.env`.
- If login/Captcha appears, use noVNC for manual handoff.
- Runtime upgrades preserve the persisted browser profile by default. Use `BRS_RESET_PROFILE_ON_SIGNATURE_CHANGE=1` only for an intentional profile wipe.
- `accounts.google.com` is excluded from default stealth/fingerprint patches because Google account and Chrome Sync flows are sensitive to spoofed browser identity.

## More Detail

Read `docs/SPEC.md` for architecture/API specifics.
