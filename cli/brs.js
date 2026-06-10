#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, extname } from 'node:path';

const DEFAULT_BROKER = process.env.BRS_BROKER_URL || 'http://127.0.0.1:17890';
const [cmd, ...args] = process.argv.slice(2);

async function main() {
  if (!cmd || ['-h', '--help', 'help'].includes(cmd)) return help();
  if (cmd === 'status') return print(await api('GET', '/status'));
  if (cmd === 'tab-audit' || cmd === 'tabs-audit' || cmd === 'audit-tabs') return print(await api('GET', '/tab-audit'));
  if (cmd === 'tab-reconcile' || cmd === 'reconcile-tabs') return print(await api('POST', '/tab-audit/reconcile', {}));
  if (cmd === 'health') return print(await api('GET', '/health'));
  if (cmd === 'leases') return print(await api('GET', '/leases'));
  if (cmd === 'jobs') return print(await api('GET', `/jobs${queryString(parseOptions(args))}`));
  if (cmd === 'job') {
    const id = args[0];
    if (!id) throw new Error('job requires <id>');
    return print(await api('GET', `/jobs/${encodeURIComponent(id)}`));
  }
  if (cmd === 'artifacts') return print(await api('GET', `/artifacts${queryString(parseOptions(args))}`));
  if (cmd === 'artifact') {
    const id = args[0];
    if (!id) throw new Error('artifact requires <id>');
    return print(await api('GET', `/artifacts/${encodeURIComponent(id)}`));
  }
  if (cmd === 'artifact-delete') {
    const id = args[0];
    if (!id) throw new Error('artifact-delete requires <id>');
    return print(await api('DELETE', `/artifacts/${encodeURIComponent(id)}`));
  }
  if (cmd === 'artifact-download') {
    const id = args[0];
    const output = args[1];
    if (!id || !output) throw new Error('artifact-download requires <id> <outputPath>');
    const data = await download(`/artifacts/${encodeURIComponent(id)}/download`);
    writeFileSync(output, data);
    return print({ ok: true, id, output, bytes: data.length });
  }
  if (cmd === 'cleanup-artifacts') return print(await api('POST', '/artifacts/cleanup', parseOptions(args)));

  if (cmd === 'acquire') return print(await api('POST', '/leases', parseOptions(args)));
  if (cmd === 'release') {
    const id = args[0];
    if (!id) throw new Error('release requires lease id');
    const closeTabs = !args.includes('--keep-tabs');
    return print(await api('DELETE', `/leases/${encodeURIComponent(id)}?closeTabs=${closeTabs}`));
  }
  if (cmd === 'open') {
    const leaseId = args[0];
    const url = args[1];
    if (!leaseId || !url) throw new Error('open requires <leaseId> <url>');
    return print(await api('POST', `/leases/${encodeURIComponent(leaseId)}/tabs`, { url, ...parseOptions(args.slice(2)) }));
  }
  if (cmd === 'browse-start') {
    const url = args[0];
    if (!url) throw new Error('browse-start requires <url>');
    const options = parseOptions(args.slice(1));
    const lease = await api('POST', '/leases', {
      agentId: options.agent || options.agentId || 'cli',
      taskId: options.task || options.taskId || 'browse',
      domain: options.domain || inferDomain(url),
      mode: options.mode || 'shared-context-tab-group',
      ttlMs: options.ttlMs,
      title: options.title,
      color: options.color,
    });
    const opened = await api('POST', `/leases/${encodeURIComponent(lease.id)}/tabs`, {
      url,
      active: options.active !== false,
      waitUntilCompleteMs: options.waitMs || options.waitUntilCompleteMs,
      timeoutMs: options.timeoutMs,
      humanize: options.humanize || options.humanizeLevel,
    });
    return print({ lease: opened.lease, tab: opened.tab });
  }
  if (cmd === 'browse-nav') {
    const leaseId = args[0];
    const tabId = args[1];
    const url = args[2];
    if (!leaseId || !tabId || !url) throw new Error('browse-nav requires <leaseId> <tabId> <url>');
    const options = parseOptions(args.slice(3));
    return print(await api('POST', `/tabs/${encodeURIComponent(tabId)}/fetch-page`, {
      url,
      leaseId,
      screenshot: Boolean(options.screenshot),
      fullPage: Boolean(options.fullPage),
      active: Boolean(options.active),
      waitUntilCompleteMs: options.waitMs || options.waitUntilCompleteMs,
      timeoutMs: options.timeoutMs,
      htmlTimeoutMs: options.htmlTimeoutMs,
      screenshotTimeoutMs: options.screenshotTimeoutMs,
      humanize: options.humanize || options.humanizeLevel,
    }));
  }
  if (cmd === 'browse-html') {
    const leaseId = args[0];
    const tabId = args[1];
    if (!leaseId || !tabId) throw new Error('browse-html requires <leaseId> <tabId>');
    return print(await api('POST', `/tabs/${encodeURIComponent(tabId)}/html`, { leaseId, ...parseOptions(args.slice(2)) }));
  }
  if (cmd === 'browse-screenshot') {
    const leaseId = args[0];
    const tabId = args[1];
    if (!leaseId || !tabId) throw new Error('browse-screenshot requires <leaseId> <tabId>');
    return print(await api('POST', `/tabs/${encodeURIComponent(tabId)}/screenshot`, { leaseId, ...parseOptions(args.slice(2)) }));
  }
  if (cmd === 'browse-end') {
    const id = args[0];
    if (!id) throw new Error('browse-end requires <leaseId>');
    const closeTabs = !args.includes('--keep-tabs');
    return print(await api('DELETE', `/leases/${encodeURIComponent(id)}?closeTabs=${closeTabs}`));
  }
  if (cmd === 'ui') {
    const tabId = args[0];
    const action = normalizeUiAction(args[1]);
    if (!tabId || !action) throw new Error('ui requires <tabId> <move|click|type|press|scroll|wait-for|upload-file>');
    const options = parseOptions(args.slice(2));
    return print(await api('POST', `/tabs/${encodeURIComponent(tabId)}/ui/${action}`, attachFilePayload(options)));
  }
  if (cmd === 'extract') {
    const extractor = args[0];
    const url = args[1];
    if (!extractor || !url) throw new Error('extract requires <extractor> <url>');
    const options = parseOptions(args.slice(2));
    const params = attachUploadFileParam(parseJsonOption(options.params || options.paramsJson, {}), options);
    return print(await api('POST', '/jobs/extract', {
      extractor,
      url,
      agentId: options.agent || options.agentId || 'cli',
      taskId: options.task || options.taskId || `extract:${extractor}`,
      screenshot: Boolean(options.screenshot),
      saveHtml: Boolean(options.saveHtml),
      fullPage: Boolean(options.fullPage),
      keepOpen: Boolean(options.keepOpen),
      active: Boolean(options.active),
      waitUntilCompleteMs: options.waitMs || options.waitUntilCompleteMs,
      humanize: options.humanize || options.humanizeLevel,
      params,
      maxAttempts: options.maxAttempts,
      retries: options.retries,
      retry: options.retry,
    }));
  }
  if (cmd === 'fetch') {
    const url = args[0];
    if (!url) throw new Error('fetch requires <url>');
    const options = parseOptions(args.slice(1));
    const leaseId = options.leaseId || options.lease;
    const tabId = options.tabId || options.tab;
    if ((leaseId && !tabId) || (!leaseId && tabId)) throw new Error('fetch tab reuse requires both --lease-id and --tab-id');
    if (leaseId && tabId) {
      return print(await api('POST', `/tabs/${encodeURIComponent(tabId)}/fetch-page`, {
        url,
        leaseId,
        screenshot: options.screenshot !== false,
        fullPage: Boolean(options.fullPage),
        active: Boolean(options.active),
        waitUntilCompleteMs: options.waitMs || options.waitUntilCompleteMs,
        timeoutMs: options.timeoutMs,
        htmlTimeoutMs: options.htmlTimeoutMs,
        screenshotTimeoutMs: options.screenshotTimeoutMs,
        humanize: options.humanize || options.humanizeLevel,
      }));
    }
    return print(await api('POST', '/jobs/fetch-page', {
      url,
      agentId: options.agent || options.agentId || 'cli',
      taskId: options.task || options.taskId || 'fetch-page',
      screenshot: options.screenshot !== false,
      fullPage: Boolean(options.fullPage),
      keepOpen: Boolean(options.keepOpen),
      active: Boolean(options.active),
      waitUntilCompleteMs: options.waitMs || options.waitUntilCompleteMs,
      humanize: options.humanize || options.humanizeLevel,
    }));
  }
  if (cmd === 'probe-session' || cmd === 'probe') {
    const platform = args[0];
    if (!platform) throw new Error(`${cmd} requires <platform>`);
    const options = parseOptions(args.slice(1));
    return print(await api('POST', '/sessions/probe', {
      platform,
      url: options.url,
      agentId: options.agent || options.agentId || 'cli',
      taskId: options.task || options.taskId || `probe:${platform}`,
      includeCookies: Boolean(options.includeCookies),
      includeStorageState: Boolean(options.includeStorageState),
      cooldown: options.cooldown,
      cooldownMode: options.cooldownMode,
      saveHtml: Boolean(options.saveHtml),
      screenshot: Boolean(options.screenshot),
      fullPage: Boolean(options.fullPage),
      keepOpen: Boolean(options.keepOpen),
      active: Boolean(options.active),
      waitUntilCompleteMs: options.waitMs || options.waitUntilCompleteMs,
      humanize: options.humanize || options.humanizeLevel,
    }));
  }
  throw new Error(`Unknown command: ${cmd}`);
}

async function download(path) {
  const res = await fetch(`${DEFAULT_BROKER}${path}`);
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status} ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}

async function api(method, path, body) {
  const res = await fetch(`${DEFAULT_BROKER}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw new Error(`${method} ${path} failed: ${res.status} ${JSON.stringify(data)}`);
  return data;
}

function parseOptions(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) out[key] = true;
    else { out[key] = coerce(next); i += 1; }
  }
  return out;
}

function queryString(options) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(options)) {
    if (value !== true && value != null) params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}

function parseJsonOption(value, fallback) {
  if (value == null || value === true) return fallback;
  try { return JSON.parse(String(value)); } catch (error) { throw new Error(`invalid JSON option: ${value}`); }
}

function inferDomain(url) {
  try { return new URL(url).hostname; } catch { return undefined; }
}

function normalizeUiAction(action) {
  const normalized = String(action || '').replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`).toLowerCase();
  const aliases = { waitfor: 'wait-for', wait: 'wait-for', upload: 'upload-file', uploadfile: 'upload-file' };
  const value = aliases[normalized] || normalized;
  return ['move', 'click', 'type', 'press', 'scroll', 'wait-for', 'upload-file'].includes(value) ? value : null;
}

function attachUploadFileParam(params, options) {
  const upload = buildFilePayload(options);
  if (!upload) return params;
  const key = options.fileParam || options.uploadFileParam || 'uploadFile';
  return { ...params, [key]: upload };
}

function attachFilePayload(options) {
  const upload = buildFilePayload(options);
  if (!upload) return options;
  const copy = { ...options, file: upload };
  delete copy.filePath;
  delete copy.uploadFile;
  delete copy.uploadFilePath;
  return copy;
}

function buildFilePayload(options) {
  const filePath = options.file || options.filePath || options.uploadFile || options.uploadFilePath;
  if (!filePath || filePath === true) return null;
  const bytes = readFileSync(String(filePath));
  return {
    name: options.fileName || basename(String(filePath)),
    mimeType: options.mimeType || mimeTypeForPath(String(filePath)),
    base64: bytes.toString('base64'),
    lastModified: Date.now(),
  };
}

function mimeTypeForPath(filePath) {
  const ext = extname(filePath).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.avif') return 'image/avif';
  if (ext === '.svg') return 'image/svg+xml';
  if (ext === '.pdf') return 'application/pdf';
  return 'application/octet-stream';
}

function coerce(value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}

function print(obj) { console.log(JSON.stringify(obj, null, 2)); }
function help() {
  console.log(`Agent Browser Runtime CLI\n\nUsage:\n  brs status\n  brs health\n  brs tab-audit\n  brs tab-reconcile\n  brs leases\n  brs jobs [--status success]\n  brs job <jobId>\n  brs artifacts [--leaseId <leaseId>] [--kind screenshot]\n  brs artifact <artifactId>\n  brs artifact-download <artifactId> <outputPath>\n  brs artifact-delete <artifactId>\n  brs cleanup-artifacts [--olderThanDays 7] [--dryRun false]\n  brs acquire --agentId demo-agent --taskId smoke --domain example.com\n  brs open <leaseId> <url>\n  brs ui <tabId> <move|click|type|press|scroll|wait-for|upload-file> [--selector input[name=q]] [--text query] [--key Enter] [--file /path/to/file]\n  brs browse-start <url> [--agent demo-agent] [--task research]\n  brs browse-nav <leaseId> <tabId> <url> [--screenshot] [--humanize enhanced]\n  brs browse-html <leaseId> <tabId>\n  brs browse-screenshot <leaseId> <tabId> [--full-page]\n  brs browse-end <leaseId> [--keep-tabs]\n  brs fetch <url> [--agent demo-agent] [--task smoke] [--screenshot] [--full-page] [--keep-open] [--humanize enhanced] [--lease-id <leaseId> --tab-id <tabId>]\n  brs probe-session <platform> [--url <url>] [--include-cookies] [--include-storage-state] [--cooldown false] [--screenshot] [--save-html] [--keep-open] [--humanize off]\n  brs extract <extractor.extract.js> <url> [--agent demo-agent] [--task smoke] [--screenshot] [--save-html] [--humanize enhanced] [--params '{"limit":3}'] [--file /path/to/file] [--file-param uploadFile] [--max-attempts 2]\n  brs release <leaseId> [--keep-tabs]\n\nEnv:\n  BRS_BROKER_URL=${DEFAULT_BROKER}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
