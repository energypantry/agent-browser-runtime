#!/usr/bin/env node
import { writeFileSync } from 'node:fs';

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
  if (cmd === 'ui') {
    const tabId = args[0];
    const action = normalizeUiAction(args[1]);
    if (!tabId || !action) throw new Error('ui requires <tabId> <move|click|type|press|scroll|wait-for>');
    return print(await api('POST', `/tabs/${encodeURIComponent(tabId)}/ui/${action}`, parseOptions(args.slice(2))));
  }
  if (cmd === 'extract') {
    const extractor = args[0];
    const url = args[1];
    if (!extractor || !url) throw new Error('extract requires <extractor> <url>');
    const options = parseOptions(args.slice(2));
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
      params: parseJsonOption(options.params || options.paramsJson, {}),
      maxAttempts: options.maxAttempts,
      retries: options.retries,
      retry: options.retry,
    }));
  }
  if (cmd === 'fetch') {
    const url = args[0];
    if (!url) throw new Error('fetch requires <url>');
    const options = parseOptions(args.slice(1));
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

function normalizeUiAction(action) {
  const normalized = String(action || '').replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`).toLowerCase();
  const aliases = { waitfor: 'wait-for', wait: 'wait-for' };
  const value = aliases[normalized] || normalized;
  return ['move', 'click', 'type', 'press', 'scroll', 'wait-for'].includes(value) ? value : null;
}

function coerce(value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}

function print(obj) { console.log(JSON.stringify(obj, null, 2)); }
function help() {
  console.log(`Agent Browser Runtime CLI\n\nUsage:\n  brs status\n  brs health\n  brs tab-audit\n  brs tab-reconcile\n  brs leases\n  brs jobs [--status success]\n  brs job <jobId>\n  brs artifacts [--leaseId <leaseId>] [--kind screenshot]\n  brs artifact <artifactId>\n  brs artifact-download <artifactId> <outputPath>\n  brs artifact-delete <artifactId>\n  brs cleanup-artifacts [--olderThanDays 7] [--dryRun false]\n  brs acquire --agentId demo-agent --taskId smoke --domain example.com\n  brs open <leaseId> <url>\n  brs ui <tabId> <move|click|type|press|scroll|wait-for> [--selector input[name=q]] [--text query] [--key Enter]\n  brs fetch <url> [--agent demo-agent] [--task smoke] [--screenshot] [--full-page] [--keep-open] [--humanize enhanced]\n  brs probe-session <platform> [--url <url>] [--include-cookies] [--include-storage-state] [--cooldown false] [--screenshot] [--save-html] [--keep-open] [--humanize off]\n  brs extract <extractor.extract.js> <url> [--agent demo-agent] [--task smoke] [--screenshot] [--save-html] [--humanize enhanced] [--params '{"limit":3}'] [--max-attempts 2]\n  brs release <leaseId> [--keep-tabs]\n\nEnv:\n  BRS_BROKER_URL=${DEFAULT_BROKER}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
