---
slug: agent-browser-runtime
display_name: Agent Browser Runtime
version: 1.0.0
tags: [browser, runtime, chrome, cdp, novnc, agent]
---

# Agent Browser Runtime

## Description

Use Agent Browser Runtime when an agent needs a compose-managed real Chrome runtime for page exploration, login-state reuse, screenshot/HTML evidence, session probes, or extractor execution.

## Runtime

Start from the repository root:

```bash
cp .env.example .env
docker compose up --build -d
./scripts/smoke-test.sh
```

Endpoints:

- Broker: `http://127.0.0.1:17890`
- CDP: `http://127.0.0.1:19223`
- noVNC: `http://127.0.0.1:16080/vnc.html?autoconnect=true&resize=remote`

## Operating Rules

- Run `./cli/brs.js status` before browser work. `extensionConnected: true` means the companion extension is ready.
- Use broker leases; one lease maps to one real Chrome Tab Group.
- Keep at least 70 ms between broker-driven browser requests.
- For unknown or sensitive platforms, serialize per target site and use seconds-to-minutes cooldowns.
- Use noVNC for login, Captcha, MFA, sliders, and account-safety checks.
- Keep `.env`, `data/`, `artifacts/`, and `runtime/profile/` local and uncommitted.
- For direct CDP legacy/debug tasks, do not use `context.pages()[0]`; create a dedicated page for the task, keep ownership explicit, and close/release it when finished.

## Browser Interaction Discipline

This rule applies to every target site, not only LinkedIn.

- Direct navigation is reserved for initial entry to an exact user-provided URL, platform/session probes, or returning to a previously captured exact URL for inspection.
- After entry, complete site workflows through the visible UI: type search terms and form values with keyboard input, move the cursor to controls before clicking, scroll/hover/pause naturally, and let the site update state through its normal front-end flow.
- For search, filters, pagination, profile/result selection, login, checkout, and account-safety flows, use real UI controls instead of synthesized destination/search URLs, querystring mutation, `location` jumps, dispatched DOM clicks, or backend/API shortcuts.
- Generated extractor scripts should use the runtime `ui` helper (`ui.type`, `ui.click`, `ui.press`, `ui.scroll`, `ui.waitFor`, `ui.move`) for in-site workflows; keep direct URL navigation limited to the initial exact entry URL or an explicitly captured inspection URL.
- If the needed UI action is not exposed by the broker or extension yet, use noVNC manual handoff or add a real browser primitive before automating that workflow.

## Commands

```bash
./cli/brs.js status
./cli/brs.js fetch https://example.com --agent demo-agent --task smoke --screenshot --humanize enhanced
./cli/brs.js probe-session linkedin --humanize off --cooldown false
./cli/brs.js extract example.extract.js https://example.com --agent demo-agent --task extractor-smoke --screenshot --save-html
./cli/brs.js acquire --agentId demo-agent --taskId research --domain example.com
./cli/brs.js open <leaseId> https://example.com
./cli/brs.js release <leaseId>
```

## Browser Consistency

The runtime exposes a default-on anti-bot/risk-control compatibility layer: `BRS_RUNTIME_PRESET=chrome124-macos`, seed-based fingerprint profile, optional mounted fingerprint-chromium binary, UA/UA-CH headers, main-world stealth evasions, locale/timezone CDP overrides, startup-level TLS gateway proxy, and humanized pacing through `BRS_*` env vars.

`./cli/brs.js status` should show `extensionConnected: true`, `stealth.tlsGateway.active: true`, and `tlsGateway.health.ok: true`.

Use `BRS_STEALTH_ENABLED=0` for debugging. Use `BRS_RESET_PROFILE_ON_SIGNATURE_CHANGE=1` only for an intentional clean browser profile.
