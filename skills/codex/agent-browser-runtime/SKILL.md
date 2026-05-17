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
- Browser consistency policy is default-on: `BRS_RUNTIME_PRESET=chrome124-macos`, seed-based fingerprint profile, optional mounted fingerprint-chromium binary, UA/UA-CH headers, main-world stealth evasions, locale/timezone CDP overrides, startup-level TLS gateway proxy, and pacing through `BRS_*` env vars.
- `./cli/brs.js status` should show `extensionConnected: true`, `stealth.enabled: true`, `stealth.fingerprint.generated: true`, `stealth.tlsGateway.active: true`, `tlsGateway.health.ok: true`, and `platformPacing`.
- Keep at least 70 ms between broker-driven browser requests. For unknown or sensitive platforms, serialize per target site and use seconds-to-minutes cooldowns.
- Use `./cli/brs.js probe-session <platform>` to check persisted login/session state for `linkedin`, `reddit`, `facebook`, `instagram`, or `generic`; cookie values are omitted unless `--include-cookies` is passed.
- For direct CDP legacy/debug tasks, do not use `context.pages()[0]`; create a dedicated page for the task, keep ownership explicit, and close/release it when finished.

## Browser Interaction Discipline

This rule applies to every target site, not only LinkedIn.

- Direct navigation is reserved for initial entry to an exact user-provided URL, platform/session probes, or returning to a previously captured exact URL for inspection.
- After entry, complete site workflows through the visible UI: type search terms and form values with keyboard input, move the cursor to controls before clicking, scroll/hover/pause naturally, and let the site update state through its normal front-end flow.
- For search, filters, pagination, profile/result selection, login, checkout, and account-safety flows, use real UI controls instead of synthesized destination/search URLs, querystring mutation, `location` jumps, dispatched DOM clicks, or backend/API shortcuts.
- Generated extractor scripts should use the runtime `ui` helper (`ui.type`, `ui.click`, `ui.press`, `ui.scroll`, `ui.waitFor`, `ui.move`) for in-site workflows; keep direct URL navigation limited to the initial exact entry URL or an explicitly captured inspection URL.
- If the needed UI action is not exposed by the broker or extension yet, use noVNC manual handoff or add a real browser primitive before automating that workflow.

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
