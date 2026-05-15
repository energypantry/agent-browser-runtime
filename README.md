# browser-runtime-skill

Compose-managed shared real-browser runtime for agents.

## Start

```bash
cp .env.example .env
docker compose up --build -d
```

## Smoke test

Full runtime smoke test:

```bash
./scripts/smoke-test.sh
```

It validates compose config/startup, broker/extension connection, humanized fetch, extractor execution, params schema, retry/error artifacts, job/artifact APIs, real Tab Group open/release, and artifact file sizes.

Quick manual checks:

```bash
./cli/brs.js status
./cli/brs.js fetch https://example.com --agent vovo --task smoke --screenshot --humanize enhanced
```

Expected outputs: broker status, HTML artifact, screenshot artifact, and a real Chrome Tab Group visible in noVNC.

## Extractor smoke

```bash
./cli/brs.js extract example.extract.js https://example.com --agent vovo --task extractor-smoke --screenshot --save-html
```

Default host CDP port is `19223` to avoid conflicts with other local browser services.

## Files

- `docs/SPEC.md` — architecture and API spec
- `docker-compose.yml` — broker + chrome-runtime
- `broker/` — HTTP/WS control plane
- `extension/` — Chrome companion extension for real Tab Groups + debugger CDP
- `runtime/chrome/` — Chromium + noVNC container
- `cli/brs.js` — small operator/client CLI
- `scripts/smoke-test.sh` — full local runtime regression test
- `extractors/` — site extractor scripts with optional params schema
- `data/`, `artifacts/`, `runtime/profile/` — runtime state, gitignored

## Internal product APIs

```bash
./cli/brs.js jobs
./cli/brs.js job <jobId>
./cli/brs.js artifacts --leaseId <leaseId>
./cli/brs.js artifact <artifactId>
./cli/brs.js artifact-download <artifactId> /tmp/result.json
./cli/brs.js cleanup-artifacts --olderThanDays 7
```

Extractors may export `schema` / `paramsSchema`; pass params with `--params '{"includeLength":true}'`. Use `--max-attempts 2` or `--retries 1` for retry. Failed extractor attempts write `error` artifacts for debugging.
