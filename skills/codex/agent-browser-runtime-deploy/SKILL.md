---
name: agent-browser-runtime-deploy
description: Deploy and verify Agent Browser Runtime locally for an agent that needs a compose-managed real Chrome runtime with persistent profile, noVNC handoff, leases, artifacts, browser consistency policy, and generic extractor execution.
---

# Agent Browser Runtime Deploy

Use this skill when asked to install, run, repair, or verify Agent Browser Runtime on a local machine.

## Requirements

- Docker with Compose v2
- Node.js 20+ on the host for the CLI and syntax checks
- Python 3 for smoke-test JSON validation
- Ports available on loopback: `17890` broker, `19223` CDP proxy, `16080` noVNC

## First Deploy

From the Agent Browser Runtime repository root:

```bash
cp .env.example .env
docker compose up --build -d
./scripts/smoke-test.sh
```

Expected endpoints:

- Broker: `http://127.0.0.1:17890`
- CDP proxy: `http://127.0.0.1:19223`
- noVNC: `http://127.0.0.1:16080/vnc.html?autoconnect=true&resize=remote`

## Verification

Run:

```bash
./cli/brs.js status
./cli/brs.js fetch https://example.com --agent deploy-check --task smoke --screenshot --humanize enhanced
./cli/brs.js extract example.extract.js https://example.com --agent deploy-check --task extractor-smoke --screenshot --save-html
```

`status` should report `extensionConnected: true`, `stealth.enabled: true`, `stealth.fingerprint.generated: true`, and `platformPacing.enabled: true`.

## Operating Rules

- Use broker leases; do not directly drive the same Chrome tabs from multiple agents.
- Keep at least 70 ms between broker-driven requests. For unknown or sensitive targets, serialize per domain and use seconds-to-minutes cooldowns.
- Use noVNC for login, Captcha, MFA, sliders, and account-safety checks.
- Keep `.env`, `data/`, `artifacts/`, and `runtime/profile/` local and uncommitted.
- Keep site-specific/private extractors outside the public repository unless they are intentionally generic examples.

## Browser Consistency Controls

Agent Browser Runtime intentionally exposes its anti-bot/risk-control browser consistency layer:

- `BRS_GENERATE_FINGERPRINT_ENABLED`
- `BRS_FINGERPRINT_HEADERS_ENABLED`
- `BRS_FINGERPRINT_PATCHES_ENABLED`
- `BRS_STEALTH_EXCLUDED_HOSTS`
- `BRS_CANVAS_NOISE_ENABLED`
- `BRS_AUDIO_NOISE_ENABLED`
- `BRS_TLS_GATEWAY_PROXY_SERVER`
- `BOT_HUMANIZE_LEVEL`

Set `BRS_STEALTH_ENABLED=0` for debugging a site compatibility issue. Set `BRS_RESET_PROFILE_ON_SIGNATURE_CHANGE=1` only when an intentional clean browser profile is required.

## Repair Loop

1. `docker compose ps`
2. `./cli/brs.js status`
3. If broker is up but `extensionConnected` is false, restart with `docker compose up --build -d`.
4. If ports are occupied, change `BROKER_HOST_PORT`, `CDP_HOST_PORT`, or `NOVNC_HOST_PORT` in `.env`.
5. If profile state is corrupt, stop the stack, back up or remove `runtime/profile/`, then start again.
