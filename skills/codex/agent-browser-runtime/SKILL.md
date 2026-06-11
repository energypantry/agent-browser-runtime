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
- For continuous work on the same site/task, keep one lease and one tab: start with `browse-start`, then use `browse-nav`, `browse-html`, `browse-screenshot`, and `browse-end`. Repeated one-shot `fetch` calls create extra leases/tab groups and should be reserved for smoke checks or isolated single-page evidence.
- Broker persists state/artifacts and owns task-level pacing; the extension executes Chrome-native browser operations, including scripted humanized mouse/scroll/pause actions.
- Default browser identity mode is `trusted-real-browser`: persistent profile, noVNC, tab groups, artifacts, UI primitives, pacing, and no page-level UA/header/WebGL/canvas/audio spoofing or startup-level timezone/AutomationControlled overrides.
- `./cli/brs.js status` should show `extensionConnected: true`, `stealth.mode: trusted-real-browser`, `stealth.enabled: false`, and `platformPacing`.
- Use `BRS_STEALTH_MODE=legacy-js` only as an explicit compatibility experiment; it enables the older extension-level UA/UA-CH headers, main-world stealth evasions, locale/timezone CDP overrides, and canvas/audio/WebGL patching.
- Use `BRS_STEALTH_MODE=patched-browser` when a mounted browser binary owns identity changes at the browser/backend layer; keep extension JS/CDP stealth off in that mode.
- Keep at least 70 ms between broker-driven browser requests. For unknown or sensitive platforms, serialize per target site and use seconds-to-minutes cooldowns.
- Use `./cli/brs.js probe-session <platform>` to check persisted login/session state for `linkedin`, `reddit`, `facebook`, `instagram`, or `generic`; cookie values are omitted unless `--include-cookies` is passed.
- For direct CDP legacy/debug tasks, do not use `context.pages()[0]`; create a dedicated page for the task, keep ownership explicit, and close/release it when finished.

## Browser Interaction Discipline

This rule applies to every target site, not only LinkedIn.

- Direct navigation is reserved for initial entry to an exact user-provided URL, platform/session probes, or returning to a previously captured exact URL for inspection.
- After entry, complete site workflows through the visible UI: type search terms and form values with keyboard input, move the cursor to controls before clicking, scroll/hover/pause naturally, and let the site update state through its normal front-end flow.
- For search, filters, pagination, profile/result selection, login, checkout, and account-safety flows, use real UI controls instead of synthesized destination/search URLs, querystring mutation, `location` jumps, dispatched DOM clicks, or backend/API shortcuts.
- Generated extractor scripts should use the runtime `ui` helper (`ui.type`, `ui.click`, `ui.press`, `ui.scroll`, `ui.waitFor`, `ui.move`, `ui.uploadFile`) for in-site workflows; keep direct URL navigation limited to the initial exact entry URL or an explicitly captured inspection URL.
- If the needed UI action is not exposed by the broker or extension yet, use noVNC manual handoff or add a real browser primitive before automating that workflow.

## Quick Commands

From the project root:

```bash
./cli/brs.js status
./cli/brs.js fetch https://example.com --agent demo-agent --task smoke --screenshot --humanize enhanced
./cli/brs.js browse-start https://example.com --agent demo-agent --task research
./cli/brs.js browse-nav <leaseId> <tabId> https://example.com/page-2 --screenshot
./cli/brs.js browse-html <leaseId> <tabId>
./cli/brs.js browse-end <leaseId>
./cli/brs.js probe-session linkedin --humanize off --cooldown false
./cli/brs.js extract example.extract.js https://example.com --agent demo-agent --task extractor-smoke --screenshot --save-html
./cli/brs.js acquire --agentId demo-agent --taskId research --domain example.com
./cli/brs.js open <leaseId> https://example.com
./cli/brs.js release <leaseId>
```

## Built-in Extractors

The runtime repo ships extractor scripts under `extractors/`; this local Codex skill also mirrors reusable scripts under `/Users/zhi/.codex/skills/agent-browser-runtime/extractors/`.

AliExpress product search extractor is available as `extractors/aliexpress.extract.js`. It uses one file with mode-specific params so image-based and text-based collection return the same `products[]` fields: product image URL, title, price, sales text/count, product URL, precision score, and match reason.

Image-search result collection:

```bash
./cli/brs.js extract aliexpress.extract.js \
  'https://www.aliexpress.com/' \
  --params '{"mode":"imageSearch","maxItems":30,"requireSales":true,"filter":"women blazer double breasted gold buttons"}' \
  --file /absolute/path/to/reference-image.png \
  --agent codex --task aliexpress-image-search --humanize standard --active true --save-html
```

Text-search collection:

```bash
./cli/brs.js extract aliexpress.extract.js \
  'https://www.aliexpress.com/' \
  --params '{"mode":"textSearch","query":"women double breasted blazer gold buttons","maxItems":30,"requireSales":true}' \
  --agent codex --task aliexpress-text-search --humanize standard --save-html
```

Modes:

- `imageSearch`: when `--file` / `params.uploadFile` is present, opens AliExpress image search, uploads the reference image with `ui.uploadFile`, waits for results, then extracts sales-backed product cards. It can also extract from an existing image-search results URL.
- `textSearch`: types `params.query` into the site search box with runtime UI helpers, submits it, scrolls, then extracts product cards.
- `auto`: infers `textSearch` when `query` is present, otherwise uses `imageSearch` for image-search URLs.

Taobao product search extractor is available as `extractors/taobao.extract.js`. It keeps the same product-search output contract as the AliExpress extractor: product image URL, title, price, sales text/count, shop name, product URL, precision score, and match reason.

Taobao image-search result collection:

```bash
./cli/brs.js extract taobao.extract.js \
  'https://www.taobao.com/' \
  --params '{"mode":"imageSearch","maxItems":40,"requireSales":true,"filter":"女士 双排扣 金扣 西装外套"}' \
  --file /absolute/path/to/reference-image.png \
  --agent codex --task taobao-image-search --humanize standard --active true --save-html
```

Taobao text-search result collection:

```bash
./cli/brs.js extract taobao.extract.js \
  'https://www.taobao.com/' \
  --params '{"mode":"textSearch","query":"女士 双排扣 金扣 西装外套","maxItems":40,"requireSales":true}' \
  --agent codex --task taobao-text-search --humanize standard --active true --save-html
```

Taobao extractor modes:

- `imageSearch`: opens the visible Taobao image-search upload flow with runtime UI helpers, uploads the reference image with `ui.uploadFile`, waits for results, scrolls, then extracts sales-backed product cards.
- `textSearch`: types `params.query` into Taobao search with runtime UI helpers, submits it, scrolls, then extracts product cards.
- `auto`: infers `textSearch` when `query` is present, otherwise uses `imageSearch` when an upload file or image-search URL is present.
- If Taobao shows login, captcha, or safety verification, use noVNC for manual handoff and rerun in the same persisted browser profile.

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
- Google, LinkedIn, JD, and GitHub are excluded from legacy JS stealth by default because high-trust login flows are sensitive to spoofed browser identity.

## More Detail

Read `docs/SPEC.md` for architecture/API specifics.
