# Docker Compose Architecture

`browser-runtime-skill` is a compose-managed local browser runtime. Agents talk to the broker; the broker talks to a Chrome companion extension over WebSocket; the extension executes Chrome-native tab/group/debugger operations.

```text
Agents / OpenClaw skills
        |
        | HTTP client / CLI
        v
broker container  <-------------------->  chrome companion extension
        |            JSON-RPC over WS          |
        |                                      | chrome.tabs.group / tabGroups / debugger
        v                                      v
SQLite state + artifacts            chrome-runtime: Chromium + noVNC + persistent profile
```

## Services

### broker

Responsibilities:

- lease allocation: `agentId`, `taskId`, `domain`, `mode`, TTL
- source of truth for leases/tabs/artifacts in SQLite
- JSON-RPC request/response channel to the companion extension
- one-shot jobs: `fetch-page`, `extract`, `sessions/probe`
- runtime status: sanitized extension-loaded fingerprint config, platform pacing policy, and optional TLS gateway health/stats
- artifact writing under `artifacts/YYYY-MM-DD/<leaseId>/`

### chrome-runtime

Responsibilities:

- persistent real Chromium profile under `runtime/profile`
- noVNC manual handoff for login/Captcha
- loads `extension/` at browser launch
- generates `runtime-config.js` from `BRS_*` env vars for the companion extension
- generates a coherent seed-based fingerprint profile unless `BRS_GENERATE_FINGERPRINT_ENABLED=0`
- applies an optional proxy/TLS gateway when `BRS_TLS_GATEWAY_PROXY_SERVER` is set and disables QUIC for that proxied path
- exposes an internal CDP proxy for diagnostics; the MVP control path uses the extension debugger API for page ops

### companion extension

Responsibilities:

- create tabs and real Chrome Tab Groups
- attach `chrome.debugger` to background tabs
- apply default browser consistency policy: generated fingerprint headers, UA metadata, locale/timezone overrides, and main-world browser-surface patches
- probe platform session state through CDP cookies, optional storage-state export, and lightweight page login/challenge signals
- capture HTML and screenshots
- close/release tabs when broker requests

## Runtime modes

- `shared-context-tab-group`: implemented; same browser profile/session, separate visual tab groups
- `isolated-context`: reserved future mode
- `dedicated-runtime`: reserved future scale-out mode for risky targets

## Ports

Host bindings are loopback-only by default:

- `127.0.0.1:17890` broker (`BROKER_HOST_PORT`)
- `127.0.0.1:19223` CDP proxy (`CDP_HOST_PORT`)
- `127.0.0.1:16080` noVNC (`NOVNC_HOST_PORT`)

Default host CDP port is intentionally `19223`; broker↔Chrome internal networking remains `chrome-runtime:19222`.
