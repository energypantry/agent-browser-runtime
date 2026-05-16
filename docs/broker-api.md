# Broker API v0.1

Base URL: `http://127.0.0.1:17890` by default (`BRS_BROKER_URL` for CLI).

## Health / Status

### `GET /health`

Returns broker liveness, CDP endpoint, and `extensionConnected`.

### `GET /status`

Returns runtime endpoints, extension connectivity, active leases, owned tabs, humanization defaults, and browser consistency policy status. `stealth.tlsGateway.active` is true only when a TLS gateway proxy is configured.

## Leases

### `POST /leases`

Create a lease. MVP mode is `shared-context-tab-group`; each lease maps to one real Chrome Tab Group once the first tab is opened.

```json
{
  "agentId": "vovo",
  "taskId": "smoke",
  "domain": "example.com",
  "mode": "shared-context-tab-group",
  "ttlMs": 1800000
}
```

### `GET /leases`

List recent leases.

### `DELETE /leases/:id?closeTabs=true`

Release a lease. By default the broker asks the extension to close owned tabs and marks them closed in SQLite.

## Tabs / Artifacts

### `GET /artifacts?leaseId=&kind=&limit=`

List artifact metadata. Use `leaseId` to fetch evidence for one job/lease and `kind` for `html`, `screenshot`, `extract-result`, or `error`.

### `GET /artifacts/:id`

Return artifact metadata.

### `GET /artifacts/:id/download`

Download artifact bytes with the stored content type.

### `DELETE /artifacts/:id`

Delete one artifact record and best-effort delete the backing file.

### `POST /artifacts/cleanup`

Dry-run by default. Deletes old artifact records/files when `dryRun=false`.

```json
{ "olderThanDays": 7, "limit": 1000, "dryRun": true }
```


### `POST /leases/:id/tabs`

Open a tab in the lease's real Chrome Tab Group.

```json
{ "url": "https://example.com", "active": false, "waitUntilCompleteMs": 15000 }
```

### `POST /tabs/:tabId/navigate`

Navigate a tab.

### `POST /tabs/:tabId/html`

Capture `document.documentElement.outerHTML` and write an HTML artifact.

### `POST /tabs/:tabId/screenshot`

Capture JPEG/PNG screenshot and write an image artifact.

## Jobs

### `GET /jobs?status=&limit=`

List recent job records.

### `GET /jobs/:id`

Return one job plus logs and lease artifacts.


### `POST /jobs/fetch-page`

One-shot workflow: create lease, open grouped tab, capture HTML, optionally screenshot, then release/close unless `keepOpen=true`.

### `POST /jobs/extract`

Run an extractor from `/extractors`. Extractor filenames must match `<name>.extract.js` and export `extract({ url, finalUrl, pageHtml, tab, params, attempt })`. Extractors may also export `schema` or `paramsSchema` for simple JSON-schema-style params validation.

```json
{
  "extractor": "example.extract.js",
  "url": "https://example.com",
  "agentId": "vovo",
  "taskId": "extractor-smoke",
  "saveHtml": true,
  "screenshot": true,
  "params": { "includeLength": true },
  "maxAttempts": 2
}
```

Returns `job`, `result`, and artifact metadata for the JSON result and optional HTML/screenshot. On final failure, returns HTTP 500 with a failed job and `error` artifacts containing URL, attempt, extractor, stack/message/code.
