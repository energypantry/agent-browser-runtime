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

The runtime exposes a default-on anti-bot/risk-control compatibility layer: seed-based fingerprint profile, UA/UA-CH headers, main-world stealth evasions, locale/timezone CDP overrides, humanized pacing, and optional TLS gateway proxy support through `BRS_*` env vars.

Use `BRS_STEALTH_ENABLED=0` for debugging. Use `BRS_RESET_PROFILE_ON_SIGNATURE_CHANGE=1` only for an intentional clean browser profile.
