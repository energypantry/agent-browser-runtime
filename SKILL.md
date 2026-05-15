---
name: browser-runtime-skill
description: Use a compose-managed real Chrome runtime with persistent profile, noVNC handoff, real Tab Groups, leases, extractor jobs, fingerprint-compatible launch, and runtime humanization for browser scraping or page exploration.
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
- Agents must use broker leases; do not directly fight over Chrome tabs.
- One lease maps to one real Chrome Tab Group.
- Broker persists state/artifacts and owns task-level pacing; the extension only executes Chrome-native browser operations, including scripting-based humanized mouse/scroll/pause actions.

## Quick commands

From the project root:

```bash
./cli/brs.js status
./cli/brs.js fetch https://example.com --agent vovo --task smoke --screenshot --humanize enhanced
./cli/brs.js extract example.extract.js https://example.com --agent vovo --task extractor-smoke --screenshot --save-html
./cli/brs.js acquire --agentId vovo --taskId research --domain example.com
./cli/brs.js open <leaseId> https://example.com
./cli/brs.js release <leaseId>
```

## Modes

1. `explore`: agent uses a leased tab group to understand a new site.
2. `record`: save selectors, screenshots, HTML, network hints, and failure states.
3. `run`: execute a stable extractor script in a leased workspace.

MVP implements `shared-context-tab-group`; use `dedicated-runtime` conceptually for risky targets that should not share profile/IP/session. Humanization profiles are `minimal`, `standard`, `enhanced`, or `off`; pass `--humanize <level>` per job or set `BOT_HUMANIZE_LEVEL`.

## Safety

- Runtime profile, artifacts, and SQLite state are gitignored.
- Do not commit cookies, credentials, screenshots with secrets, or `.env`.
- If login/Captcha appears, use noVNC for manual handoff instead of trying to bypass it.

## More detail

Read `docs/SPEC.md` for architecture/API specifics.
