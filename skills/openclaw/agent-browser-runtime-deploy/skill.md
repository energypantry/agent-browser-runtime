---
slug: agent-browser-runtime-deploy
display_name: Agent Browser Runtime Deploy
version: 1.0.0
tags: [browser, runtime, deployment, docker, chrome, novnc]
---

# Agent Browser Runtime Deploy

## Description

Deploy and verify Agent Browser Runtime locally for agents that need a compose-managed real Chrome runtime.

## Requirements

- Docker with Compose v2
- Node.js 20+ on the host for the CLI and syntax checks
- Python 3 for smoke-test JSON validation
- Ports available on loopback: `17890`, `19223`, `16080`

## First Deploy

From the repository root:

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

```bash
./cli/brs.js status
./cli/brs.js fetch https://example.com --agent deploy-check --task smoke --screenshot --humanize enhanced
./cli/brs.js extract example.extract.js https://example.com --agent deploy-check --task extractor-smoke --screenshot --save-html
```

`status` should report `extensionConnected: true`, `stealth.enabled: true`, `stealth.fingerprint.generated: true`, and `platformPacing.enabled: true`.

## Repair Loop

1. `docker compose ps`
2. `./cli/brs.js status`
3. If broker is up but `extensionConnected` is false, restart with `docker compose up --build -d`.
4. If ports are occupied, change `BROKER_HOST_PORT`, `CDP_HOST_PORT`, or `NOVNC_HOST_PORT` in `.env`.
5. If profile state is corrupt, stop the stack, back up or remove `runtime/profile/`, then start again.
