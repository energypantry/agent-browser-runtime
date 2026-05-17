import { mkdir, writeFile, stat, readFile, unlink } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { Store } from './store.js';
import { ExtensionRpc } from './extension-rpc.js';

const host = process.env.BROKER_HOST || '0.0.0.0';
const port = Number(process.env.BROKER_PORT || 17890);
const cdpEndpoint = process.env.CDP_ENDPOINT || 'http://chrome-runtime:19222';
const novncUrl = process.env.NOVNC_URL || null;
const leaseDbPath = process.env.LEASE_DB_PATH || '/data/leases.sqlite';
const artifactsDir = process.env.ARTIFACTS_DIR || '/artifacts';
const extractorsDir = process.env.EXTRACTORS_DIR || '/extractors';
const defaultHumanizeLevel = String(process.env.BOT_HUMANIZE_LEVEL || 'standard').trim().toLowerCase();

const app = Fastify({ logger: true });
await app.register(websocket);

const store = new Store(leaseDbPath);
const extension = new ExtensionRpc(app.log);
const platformLastActionAt = new Map();

app.get('/extension', { websocket: true }, (socket) => {
  app.log.info('Chrome companion extension connected');
  extension.attach(socket);
});

app.get('/health', async () => ({
  ok: true,
  cdpEndpoint,
  extensionConnected: extension.connected,
}));

app.get('/status', async () => ({
  ...(await runtimeStatus()),
}));

app.get('/tab-audit', async () => ({
  ok: true,
  ...(await tabOwnershipAudit()),
}));

app.post('/tab-audit/reconcile', async (request, reply) => {
  const audit = await tabOwnershipAudit();
  if (!audit.ok) {
    return reply.code(503).send({ ok: false, error: audit.error || 'TAB_AUDIT_FAILED', audit });
  }
  for (const tab of audit.trackedMissingTabs || []) store.closeTab(tab.id);
  return { ok: true, closedMissingTrackedTabs: (audit.trackedMissingTabs || []).map((tab) => tab.id), audit };
});

app.get('/artifacts', async (request) => ({
  artifacts: store.listArtifacts({
    leaseId: request.query?.leaseId || null,
    kind: request.query?.kind || null,
    before: request.query?.before || null,
    limit: readPositiveNumber(request.query?.limit, 300),
  }),
}));

app.get('/artifacts/:id', async (request, reply) => {
  const artifact = store.getArtifact(request.params.id);
  if (!artifact) return reply.code(404).send({ ok: false, error: 'ARTIFACT_NOT_FOUND' });
  return artifact;
});

app.get('/artifacts/:id/download', async (request, reply) => {
  const artifact = store.getArtifact(request.params.id);
  if (!artifact) return reply.code(404).send({ ok: false, error: 'ARTIFACT_NOT_FOUND' });
  const localPath = safeArtifactPath(artifact.path);
  const data = await readFile(localPath);
  reply.header('content-type', artifact.mimeType || 'application/octet-stream');
  reply.header('content-disposition', `attachment; filename="${basename(localPath)}"`);
  return reply.send(data);
});

app.delete('/artifacts/:id', async (request, reply) => {
  const artifact = store.getArtifact(request.params.id);
  if (!artifact) return reply.code(404).send({ ok: false, error: 'ARTIFACT_NOT_FOUND' });
  await unlink(safeArtifactPath(artifact.path)).catch((error) => app.log.warn({ error, artifactId: artifact.id }, 'artifact file delete failed'));
  store.deleteArtifact(artifact.id);
  return { ok: true, deleted: artifact.id };
});

app.post('/artifacts/cleanup', async (request) => {
  const body = request.body || {};
  const olderThanDays = readPositiveNumber(body.olderThanDays, 7);
  const before = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();
  const dryRun = body.dryRun !== false;
  const candidates = store.listArtifacts({ before, limit: readPositiveNumber(body.limit, 1000) });
  let bytes = 0;
  const deleted = [];
  for (const artifact of candidates) {
    bytes += Number(artifact.bytes || 0);
    if (!dryRun) {
      await unlink(safeArtifactPath(artifact.path)).catch((error) => app.log.warn({ error, artifactId: artifact.id }, 'artifact cleanup file delete failed'));
      store.deleteArtifact(artifact.id);
      deleted.push(artifact.id);
    }
  }
  return { ok: true, dryRun, before, candidates: candidates.length, bytes, deleted };
});

app.get('/jobs', async (request) => ({ jobs: store.listJobs({ status: request.query?.status || null, limit: readPositiveNumber(request.query?.limit, 100) }) }));

app.get('/jobs/:id', async (request, reply) => {
  const job = store.getJob(request.params.id);
  if (!job) return reply.code(404).send({ ok: false, error: 'JOB_NOT_FOUND' });
  return { ...job, logs: store.listJobLogs(job.id), artifacts: store.listArtifacts({ leaseId: job.leaseId, limit: 100 }) };
});

app.post('/leases', async (request) => {
  const body = request.body || {};
  const now = Date.now();
  const domain = body.domain ? String(body.domain) : inferDomain(body.url);
  const id = body.id ? sanitizeId(String(body.id)) : `lease_${now}_${Math.random().toString(36).slice(2, 8)}`;
  const ttlMs = readPositiveNumber(body.ttlMs, 30 * 60 * 1000);
  const title = body.title || compactTitle([body.agentId || 'agent', body.taskId || id, domain].filter(Boolean).join(' / '));
  const lease = {
    id,
    agentId: String(body.agentId || 'unknown-agent'),
    taskId: String(body.taskId || id),
    domain,
    mode: String(body.mode || 'shared-context-tab-group'),
    chromeGroupId: null,
    title,
    color: body.color || colorFor(id),
    status: 'allocated',
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMs).toISOString(),
  };
  store.createLease(lease);
  return { ...lease, tabs: [] };
});

app.get('/leases', async () => store.listLeases({ activeOnly: false }));

app.delete('/leases/:id', async (request, reply) => {
  const lease = requireLease(request.params.id, reply);
  if (!lease) return reply;
  const closeTabs = request.query?.closeTabs !== 'false';
  const tabs = store.listTabs(lease.id).filter((tab) => tab.status !== 'closed');
  if (closeTabs) {
    for (const tab of tabs) {
      await extension.call('tabs.close', { tabId: tab.id }).catch((error) => app.log.warn({ error, tabId: tab.id }, 'tab close failed'));
      store.closeTab(tab.id);
    }
  }
  store.releaseLease(lease.id);
  return { ok: true, released: lease.id, closedTabs: closeTabs ? tabs.map((tab) => tab.id) : [] };
});

app.post('/leases/:id/tabs', async (request, reply) => {
  const lease = requireLease(request.params.id, reply);
  if (!lease) return reply;
  const body = request.body || {};
  const result = await extension.call('tabs.create', {
    url: body.url || 'about:blank',
    groupId: lease.chromeGroupId,
    groupTitle: lease.title,
    groupColor: lease.color,
    active: Boolean(body.active),
    waitUntilCompleteMs: readPositiveNumber(body.waitUntilCompleteMs, 15000),
  }, { timeoutMs: readPositiveNumber(body.timeoutMs, 45000) });
  if (result.chromeGroupId != null && result.chromeGroupId !== lease.chromeGroupId) store.updateLeaseGroup(lease.id, result.chromeGroupId);
  store.addTab({
    id: result.tab.id,
    leaseId: lease.id,
    url: result.tab.url || body.url || null,
    title: result.tab.title || body.title || null,
    status: 'open',
    createdAt: new Date().toISOString(),
  });
  await humanizeTab(result.tab.id, body, 'open');
  return { lease: store.getLease(lease.id), tab: result.tab };
});

app.post('/tabs/:tabId/navigate', async (request) => {
  const tabId = Number(request.params.tabId);
  const body = request.body || {};
  const result = await extension.call('tabs.navigate', {
    tabId,
    url: String(body.url),
    waitUntilCompleteMs: readPositiveNumber(body.waitUntilCompleteMs, 15000),
  }, { timeoutMs: readPositiveNumber(body.timeoutMs, 45000) });
  await humanizeTab(tabId, body, 'navigate');
  return result;
});

app.post('/tabs/:tabId/html', async (request) => {
  const tabId = Number(request.params.tabId);
  const body = request.body || {};
  await humanizeTab(tabId, body, 'before-html');
  const result = await extension.call('page.html', { tabId }, { timeoutMs: readPositiveNumber(body.timeoutMs, 30000) });
  return writeArtifact({ leaseId: body.leaseId, tabId, kind: 'html', ext: 'html', mimeType: 'text/html', data: result.html || '' });
});

app.post('/tabs/:tabId/screenshot', async (request) => {
  const tabId = Number(request.params.tabId);
  const body = request.body || {};
  await humanizeTab(tabId, body, 'before-screenshot');
  const result = await extension.call('screenshot.capture', {
    tabId,
    fullPage: Boolean(body.fullPage),
    format: body.format || 'jpeg',
    quality: readPositiveNumber(body.quality, 80),
  }, { timeoutMs: readPositiveNumber(body.timeoutMs, 45000) });
  const ext = result.format === 'png' ? 'png' : 'jpg';
  return writeArtifact({ leaseId: body.leaseId, tabId, kind: 'screenshot', ext, mimeType: `image/${ext === 'jpg' ? 'jpeg' : 'png'}`, base64: result.data });
});

app.post('/tabs/:tabId/ui/move', async (request) => runUiAction(Number(request.params.tabId), 'move', request.body || {}));
app.post('/tabs/:tabId/ui/click', async (request) => runUiAction(Number(request.params.tabId), 'click', request.body || {}));
app.post('/tabs/:tabId/ui/type', async (request) => runUiAction(Number(request.params.tabId), 'type', request.body || {}));
app.post('/tabs/:tabId/ui/press', async (request) => runUiAction(Number(request.params.tabId), 'press', request.body || {}));
app.post('/tabs/:tabId/ui/scroll', async (request) => runUiAction(Number(request.params.tabId), 'scroll', request.body || {}));
app.post('/tabs/:tabId/ui/wait-for', async (request) => runUiAction(Number(request.params.tabId), 'waitFor', request.body || {}));

app.post('/jobs/extract', async (request, reply) => {
  const body = request.body || {};
  if (!body.url) return reply.code(400).send({ ok: false, error: 'url is required' });
  const extractorName = sanitizeExtractorName(body.extractor || 'example.extract.js');
  const extractorPath = join(extractorsDir, extractorName);
  const extractorModule = await import(`${pathToFileURL(extractorPath).href}?t=${Date.now()}`);
  const extract = extractorModule.extract || extractorModule.default;
  if (typeof extract !== 'function') return reply.code(400).send({ ok: false, error: `Extractor ${extractorName} must export extract()` });

  let params;
  try {
    params = validateParams(body.params || {}, extractorModule.schema || extractorModule.paramsSchema || null);
  } catch (error) {
    return reply.code(400).send({ ok: false, error: error.message, details: error.details || null });
  }

  const maxAttempts = readRetryAttempts(body);
  const nowIso = new Date().toISOString();
  const jobId = `extract_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  store.createJob({
    id: jobId,
    kind: 'extract',
    status: 'queued',
    agentId: String(body.agentId || 'agent'),
    taskId: String(body.taskId || `extract:${extractorName}`),
    url: String(body.url),
    extractor: extractorName,
    attempts: 0,
    maxAttempts,
    createdAt: nowIso,
    updatedAt: nowIso,
  });

  const lease = store.createLease({
    id: jobId,
    agentId: String(body.agentId || 'agent'),
    taskId: String(body.taskId || `extract:${extractorName}`),
    domain: inferDomain(body.url),
    mode: String(body.mode || 'shared-context-tab-group'),
    chromeGroupId: null,
    title: compactTitle(body.title || `${body.agentId || 'agent'} / ${extractorName}`),
    color: body.color || colorFor(`${body.url}:${extractorName}`),
    status: 'allocated',
    createdAt: nowIso,
    expiresAt: new Date(Date.now() + readPositiveNumber(body.ttlMs, 15 * 60 * 1000)).toISOString(),
  });
  store.updateJob(jobId, { leaseId: lease.id });

  const artifacts = [];
  let created = null;
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    created = null;
    store.updateJob(jobId, { status: 'running', attempts: attempt });
    addJobLog(jobId, 'info', 'attempt.start', { attempt, maxAttempts, url: body.url, extractor: extractorName });
    try {
      const currentLease = store.getLease(lease.id);
      created = await extension.call('tabs.create', {
        url: body.url,
        groupId: currentLease?.chromeGroupId || undefined,
        groupTitle: lease.title,
        groupColor: lease.color,
        active: Boolean(body.active),
        waitUntilCompleteMs: readPositiveNumber(body.waitUntilCompleteMs, 15000),
      }, { timeoutMs: readPositiveNumber(body.timeoutMs, 60000) });
      if (created.chromeGroupId != null && created.chromeGroupId !== currentLease?.chromeGroupId) store.updateLeaseGroup(lease.id, created.chromeGroupId);
      store.addTab({ id: created.tab.id, leaseId: lease.id, url: created.tab.url || body.url, title: created.tab.title, status: 'open', createdAt: new Date().toISOString() });

      await humanizeTab(created.tab.id, body, 'job-open');
      const htmlResult = await extension.call('page.html', { tabId: created.tab.id }, { timeoutMs: readPositiveNumber(body.htmlTimeoutMs, 30000) });
      const result = await extract({
        url: body.url,
        finalUrl: created.tab.url,
        pageHtml: htmlResult.html || '',
        tab: created.tab,
        ui: createTabUi(created.tab.id, body),
        params,
        attempt,
      });
      artifacts.push(await writeArtifact({ leaseId: lease.id, tabId: created.tab.id, kind: 'extract-result', ext: 'json', mimeType: 'application/json', data: JSON.stringify(result ?? null, null, 2) }));
      if (body.saveHtml) artifacts.push(await writeArtifact({ leaseId: lease.id, tabId: created.tab.id, kind: 'html', ext: 'html', mimeType: 'text/html', data: htmlResult.html || '' }));
      if (body.screenshot) {
        await humanizeTab(created.tab.id, body, 'before-screenshot');
        const shot = await extension.call('screenshot.capture', { tabId: created.tab.id, fullPage: Boolean(body.fullPage), format: body.format || 'jpeg', quality: readPositiveNumber(body.quality, 80) }, { timeoutMs: readPositiveNumber(body.screenshotTimeoutMs, 45000) });
        artifacts.push(await writeArtifact({ leaseId: lease.id, tabId: created.tab.id, kind: 'screenshot', ext: shot.format === 'png' ? 'png' : 'jpg', mimeType: shot.format === 'png' ? 'image/png' : 'image/jpeg', base64: shot.data }));
      }
      if (!body.keepOpen) {
        await extension.call('tabs.close', { tabId: created.tab.id }).catch(() => {});
        store.closeTab(created.tab.id);
        store.releaseLease(lease.id);
      }
      store.updateJob(jobId, { status: 'success', finishedAt: new Date().toISOString(), error: null });
      addJobLog(jobId, 'info', 'attempt.success', { attempt, artifactCount: artifacts.length });
      return { job: store.getJob(jobId), lease: store.getLease(lease.id), tab: created.tab, extractor: extractorName, result, artifacts };
    } catch (error) {
      lastError = normalizeError(error);
      addJobLog(jobId, 'error', 'attempt.failed', { attempt, error: lastError });
      if (created?.tab?.id) {
        artifacts.push(await writeArtifact({ leaseId: lease.id, tabId: created.tab.id, kind: 'error', ext: 'json', mimeType: 'application/json', data: JSON.stringify({ jobId, attempt, maxAttempts, url: body.url, extractor: extractorName, error: lastError }, null, 2) }));
        await extension.call('tabs.close', { tabId: created.tab.id }).catch(() => {});
        store.closeTab(created.tab.id);
        store.updateLeaseGroup(lease.id, null);
      }
      if (attempt < maxAttempts) await sleep(readPositiveNumber(body.retryDelayMs, 750) * attempt);
    }
  }

  store.releaseLease(lease.id, 'released');
  store.updateJob(jobId, { status: 'failed', finishedAt: new Date().toISOString(), error: JSON.stringify(lastError) });
  return reply.code(500).send({ ok: false, job: store.getJob(jobId), lease: store.getLease(lease.id), extractor: extractorName, error: lastError, artifacts });
});

app.post('/jobs/fetch-page', async (request) => {
  const body = request.body || {};
  if (!body.url) throw new Error('url is required');
  const lease = store.createLease({
    id: `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    agentId: String(body.agentId || 'agent'),
    taskId: String(body.taskId || 'fetch-page'),
    domain: inferDomain(body.url),
    mode: String(body.mode || 'shared-context-tab-group'),
    chromeGroupId: null,
    title: compactTitle(body.title || `${body.agentId || 'agent'} / ${inferDomain(body.url)}`),
    color: body.color || colorFor(String(body.url)),
    status: 'allocated',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + readPositiveNumber(body.ttlMs, 15 * 60 * 1000)).toISOString(),
  });

  const created = await extension.call('tabs.create', {
    url: body.url,
    groupTitle: lease.title,
    groupColor: lease.color,
    active: Boolean(body.active),
    waitUntilCompleteMs: readPositiveNumber(body.waitUntilCompleteMs, 15000),
  }, { timeoutMs: readPositiveNumber(body.timeoutMs, 60000) });
  store.updateLeaseGroup(lease.id, created.chromeGroupId);
  store.addTab({ id: created.tab.id, leaseId: lease.id, url: created.tab.url || body.url, title: created.tab.title, status: 'open', createdAt: new Date().toISOString() });

  await humanizeTab(created.tab.id, body, 'job-open');
  const htmlResult = await extension.call('page.html', { tabId: created.tab.id }, { timeoutMs: 30000 });
  const artifacts = [await writeArtifact({ leaseId: lease.id, tabId: created.tab.id, kind: 'html', ext: 'html', mimeType: 'text/html', data: htmlResult.html || '' })];
  if (body.screenshot !== false) {
    await humanizeTab(created.tab.id, body, 'before-screenshot');
    const shot = await extension.call('screenshot.capture', { tabId: created.tab.id, fullPage: Boolean(body.fullPage), format: body.format || 'jpeg', quality: readPositiveNumber(body.quality, 80) }, { timeoutMs: 45000 });
    artifacts.push(await writeArtifact({ leaseId: lease.id, tabId: created.tab.id, kind: 'screenshot', ext: shot.format === 'png' ? 'png' : 'jpg', mimeType: shot.format === 'png' ? 'image/png' : 'image/jpeg', base64: shot.data }));
  }
  if (!body.keepOpen) {
    await extension.call('tabs.close', { tabId: created.tab.id }).catch(() => {});
    store.closeTab(created.tab.id);
    store.releaseLease(lease.id);
  }
  return { lease: store.getLease(lease.id), tab: created.tab, artifacts };
});

app.post('/sessions/probe', async (request, reply) => {
  const body = request.body || {};
  const platform = String(body.platform || 'generic').toLowerCase();
  const url = body.url || defaultPlatformUrl(platform);
  const pacing = await enforcePlatformCooldown(platform, body);
  if (pacing.rejected) {
    return reply.code(429).send({ ok: false, error: 'PLATFORM_COOLDOWN', platform, ...pacing });
  }
  const nowIso = new Date().toISOString();
  const lease = store.createLease({
    id: `probe_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    agentId: String(body.agentId || 'agent'),
    taskId: String(body.taskId || `probe:${platform}`),
    domain: inferDomain(url),
    mode: String(body.mode || 'session-probe'),
    chromeGroupId: null,
    title: compactTitle(body.title || `${body.agentId || 'agent'} / ${platform} probe`),
    color: body.color || colorFor(`${platform}:${url}`),
    status: 'allocated',
    createdAt: nowIso,
    expiresAt: new Date(Date.now() + readPositiveNumber(body.ttlMs, 10 * 60 * 1000)).toISOString(),
  });

  let created = null;
  const artifacts = [];
  try {
    created = await extension.call('tabs.create', {
      url,
      groupTitle: lease.title,
      groupColor: lease.color,
      active: Boolean(body.active),
      waitUntilCompleteMs: readPositiveNumber(body.waitUntilCompleteMs, 15000),
    }, { timeoutMs: readPositiveNumber(body.timeoutMs, 60000) });
    store.updateLeaseGroup(lease.id, created.chromeGroupId);
    store.addTab({ id: created.tab.id, leaseId: lease.id, url: created.tab.url || url, title: created.tab.title, status: 'open', createdAt: new Date().toISOString() });
    await humanizeTab(created.tab.id, body, 'job-open');

    const probe = await extension.call('session.probe', {
      tabId: created.tab.id,
      platform,
      includeCookies: Boolean(body.includeCookies),
      includeStorageState: Boolean(body.includeStorageState),
      waitUntilCompleteMs: readPositiveNumber(body.waitUntilCompleteMs, 15000),
    }, { timeoutMs: readPositiveNumber(body.probeTimeoutMs, 45000) });
    artifacts.push(await writeArtifact({ leaseId: lease.id, tabId: created.tab.id, kind: 'session-probe', ext: 'json', mimeType: 'application/json', data: JSON.stringify(probe, null, 2) }));

    if (body.saveHtml) {
      const htmlResult = await extension.call('page.html', { tabId: created.tab.id }, { timeoutMs: readPositiveNumber(body.htmlTimeoutMs, 30000) });
      artifacts.push(await writeArtifact({ leaseId: lease.id, tabId: created.tab.id, kind: 'html', ext: 'html', mimeType: 'text/html', data: htmlResult.html || '' }));
    }
    if (body.screenshot) {
      await humanizeTab(created.tab.id, body, 'before-screenshot');
      const shot = await extension.call('screenshot.capture', { tabId: created.tab.id, fullPage: Boolean(body.fullPage), format: body.format || 'jpeg', quality: readPositiveNumber(body.quality, 80) }, { timeoutMs: readPositiveNumber(body.screenshotTimeoutMs, 45000) });
      artifacts.push(await writeArtifact({ leaseId: lease.id, tabId: created.tab.id, kind: 'screenshot', ext: shot.format === 'png' ? 'png' : 'jpg', mimeType: shot.format === 'png' ? 'image/png' : 'image/jpeg', base64: shot.data }));
    }
    if (!body.keepOpen) {
      await extension.call('tabs.close', { tabId: created.tab.id }).catch(() => {});
      store.closeTab(created.tab.id);
      store.releaseLease(lease.id);
    }
    return { lease: store.getLease(lease.id), tab: created.tab, probe, pacing, artifacts };
  } catch (error) {
    const normalized = normalizeError(error);
    if (created?.tab?.id) {
      artifacts.push(await writeArtifact({ leaseId: lease.id, tabId: created.tab.id, kind: 'error', ext: 'json', mimeType: 'application/json', data: JSON.stringify({ platform, url, error: normalized }, null, 2) }));
      if (!body.keepOpen) {
        await extension.call('tabs.close', { tabId: created.tab.id }).catch(() => {});
        store.closeTab(created.tab.id);
      }
    }
    if (!body.keepOpen) store.releaseLease(lease.id, 'released');
    return reply.code(500).send({ ok: false, lease: store.getLease(lease.id), platform, url, pacing, error: normalized, artifacts });
  }
});


async function humanizeTab(tabId, body = {}, stage = 'action') {
  const policy = buildHumanizePolicy(body.humanizePolicy || body.humanize || {});
  if (body.humanize === false || policy.level === 'off') return null;
  try {
    if (stage === 'open' || stage === 'navigate' || stage === 'job-open') {
      await extension.call('humanize.warmup', { tabId, policy }, { timeoutMs: readPositiveNumber(body.humanizeTimeoutMs, 60000) });
      if (stage === 'job-open') await extension.call('humanize.scroll', { tabId, policy }, { timeoutMs: readPositiveNumber(body.humanizeTimeoutMs, 60000) });
      return { ok: true, stage, policy };
    }
    if (stage === 'before-html') {
      await extension.call('humanize.pause', { policy, minMs: policy.actionPauseMinMs, maxMs: policy.actionPauseMaxMs }, { timeoutMs: readPositiveNumber(body.humanizeTimeoutMs, 60000) });
      return { ok: true, stage, policy };
    }
    if (stage === 'before-screenshot') {
      await extension.call('humanize.scroll', { tabId, policy, count: 1 }, { timeoutMs: readPositiveNumber(body.humanizeTimeoutMs, 60000) });
      await extension.call('humanize.pause', { policy, minMs: policy.microRestMinMs, maxMs: policy.microRestMaxMs }, { timeoutMs: readPositiveNumber(body.humanizeTimeoutMs, 60000) });
      return { ok: true, stage, policy };
    }
  } catch (error) {
    app.log.warn({ error, errorMessage: error?.message, errorCode: error?.code, tabId, stage }, 'humanize action failed');
  }
  return null;
}

async function runUiAction(tabId, action, body = {}) {
  const method = `ui.${action}`;
  const actionTimeoutMs = readPositiveNumber(body.timeoutMs, 45000);
  const rpcTimeoutMs = action === 'waitFor' ? actionTimeoutMs + 1500 : actionTimeoutMs;
  const result = await extension.call(method, { ...body, tabId }, { timeoutMs: rpcTimeoutMs });
  if (body.pauseAfterMs) {
    await extension.call('humanize.pause', {
      policy: buildHumanizePolicy(body.humanizePolicy || body.humanize || {}),
      minMs: body.pauseAfterMs,
      maxMs: body.pauseAfterMs,
    }, { timeoutMs: readPositiveNumber(body.humanizeTimeoutMs, 60000) });
  }
  return result;
}

function createTabUi(tabId, defaults = {}) {
  const withDefaults = (params = {}) => ({
    humanize: defaults.humanize,
    humanizePolicy: defaults.humanizePolicy,
    ...params,
  });
  return {
    move: (params = {}) => runUiAction(tabId, 'move', withDefaults(params)),
    click: (params = {}) => runUiAction(tabId, 'click', withDefaults(params)),
    type: (paramsOrText = {}, text = null) => runUiAction(tabId, 'type', withDefaults(normalizeTypeArgs(paramsOrText, text))),
    press: (keyOrParams = {}) => runUiAction(tabId, 'press', withDefaults(typeof keyOrParams === 'string' ? { key: keyOrParams } : keyOrParams)),
    scroll: (params = {}) => runUiAction(tabId, 'scroll', withDefaults(params)),
    waitFor: (params = {}) => runUiAction(tabId, 'waitFor', withDefaults(params)),
    html: async (params = {}) => {
      await humanizeTab(tabId, withDefaults(params), 'before-html');
      return extension.call('page.html', { tabId }, { timeoutMs: readPositiveNumber(params.timeoutMs, 30000) });
    },
    screenshot: async (params = {}) => {
      await humanizeTab(tabId, withDefaults(params), 'before-screenshot');
      return extension.call('screenshot.capture', {
        tabId,
        fullPage: Boolean(params.fullPage),
        format: params.format || 'jpeg',
        quality: readPositiveNumber(params.quality, 80),
      }, { timeoutMs: readPositiveNumber(params.timeoutMs, 45000) });
    },
  };
}

function normalizeTypeArgs(paramsOrText, text) {
  if (typeof paramsOrText === 'string') return { text: paramsOrText };
  if (text != null) return { ...(paramsOrText || {}), text };
  return paramsOrText || {};
}

function buildHumanizePolicy(input = {}) {
  const namedProfiles = {
    minimal: { level: 'minimal', actionPauseMinMs: 80, actionPauseMaxMs: 260, scrollCountMin: 0, scrollCountMax: 1, microRestProbability: 0.05 },
    standard: { level: 'standard', actionPauseMinMs: 180, actionPauseMaxMs: 700, scrollCountMin: 1, scrollCountMax: 3, microRestProbability: 0.18 },
    enhanced: { level: 'enhanced', actionPauseMinMs: 350, actionPauseMaxMs: 1200, scrollCountMin: 2, scrollCountMax: 5, microRestProbability: 0.28, microRestMinMs: 1200, microRestMaxMs: 3200 },
  };
  const requestedLevel = typeof input === 'string' ? input : input.level;
  const level = String(requestedLevel || defaultHumanizeLevel || 'standard').toLowerCase();
  const base = namedProfiles[level] || namedProfiles.standard;
  return { ...base, ...(typeof input === 'object' && input ? input : {}), level };
}


function readRetryAttempts(body = {}) {
  if (body.maxAttempts != null) return Math.max(1, Math.min(5, Number(body.maxAttempts) || 1));
  if (body.retries != null) return Math.max(1, Math.min(5, (Number(body.retries) || 0) + 1));
  if (body.retry === true) return 2;
  return 1;
}

function validateParams(params = {}, schema = null) {
  if (!schema) return params;
  const source = params && typeof params === 'object' && !Array.isArray(params) ? { ...params } : {};
  const normalized = { ...source };
  const objectSchema = schema.type === 'object' || schema.properties ? schema : { type: 'object', properties: schema };
  const properties = objectSchema.properties || {};
  const required = new Set(objectSchema.required || []);
  const errors = [];

  for (const [key, definition] of Object.entries(properties)) {
    const rule = typeof definition === 'string' ? { type: definition } : (definition || {});
    if (normalized[key] == null && Object.prototype.hasOwnProperty.call(rule, 'default')) normalized[key] = rule.default;
    if (required.has(key) && normalized[key] == null) {
      errors.push(`${key} is required`);
      continue;
    }
    if (normalized[key] != null && rule.type && !matchesType(normalized[key], rule.type)) errors.push(`${key} must be ${rule.type}`);
    if (Array.isArray(rule.enum) && normalized[key] != null && !rule.enum.includes(normalized[key])) errors.push(`${key} must be one of ${rule.enum.join(', ')}`);
  }

  if (objectSchema.additionalProperties === false) {
    for (const key of Object.keys(normalized)) {
      if (!Object.prototype.hasOwnProperty.call(properties, key)) errors.push(`${key} is not allowed`);
    }
  }

  if (errors.length) {
    const error = new Error('invalid extractor params');
    error.details = errors;
    throw error;
  }
  return normalized;
}

function matchesType(value, type) {
  if (Array.isArray(type)) return type.some((item) => matchesType(value, item));
  if (type === 'array') return Array.isArray(value);
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'object') return value && typeof value === 'object' && !Array.isArray(value);
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'string') return typeof value === 'string';
  return true;
}

function addJobLog(jobId, level, event, data = null) {
  store.addJobLog({
    id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    jobId,
    level,
    event,
    data,
    createdAt: new Date().toISOString(),
  });
}

function normalizeError(error) {
  return {
    name: error?.name || 'Error',
    message: error?.message || String(error),
    code: error?.code || null,
    stack: error?.stack ? String(error.stack).split('\n').slice(0, 12).join('\n') : null,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function safeArtifactPath(path) {
  const root = resolve(artifactsDir);
  const local = resolve(String(path));
  if (local !== root && !local.startsWith(`${root}/`)) throw Object.assign(new Error('artifact path escapes artifacts dir'), { code: 'BAD_ARTIFACT_PATH' });
  return local;
}

async function writeArtifact({ leaseId, tabId, kind, ext, mimeType, data, base64 }) {
  const day = new Date().toISOString().slice(0, 10);
  const dir = join(artifactsDir, day, sanitizeId(leaseId || 'unleased'));
  await mkdir(dir, { recursive: true });
  const id = `${kind}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const path = join(dir, `${id}.${ext}`);
  const payload = base64 ? Buffer.from(base64, 'base64') : String(data ?? '');
  await writeFile(path, payload);
  const info = await stat(path);
  const artifact = { id, leaseId, tabId, kind, path: resolve(path), mimeType, bytes: info.size, createdAt: new Date().toISOString() };
  store.addArtifact(artifact);
  return artifact;
}


function sanitizeExtractorName(value) {
  const name = String(value).replace(/^\/+/, '');
  if (!/^[a-zA-Z0-9_.-]+\.extract\.js$/.test(name)) throw new Error('extractor must match <name>.extract.js');
  return name;
}

function requireLease(id, reply) {
  const lease = store.getLease(id);
  if (!lease || lease.status !== 'allocated') {
    reply.code(404).send({ ok: false, error: 'LEASE_NOT_FOUND' });
    return null;
  }
  return lease;
}

function inferDomain(url) {
  if (!url) return null;
  try { return new URL(url).hostname; } catch { return null; }
}

function sanitizeId(value) {
  return String(value).replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 96);
}

function compactTitle(value) {
  return String(value).replace(/\s+/g, ' ').trim().slice(0, 48) || 'agent-task';
}

function readPositiveNumber(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : fallback;
}

function readNonNegativeNumber(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) && num >= 0 ? num : fallback;
}

async function runtimeStatus() {
  const runtimeConfig = await readRuntimeConfig();
  const tlsGateway = await tlsGatewayStatus();
  return {
    ok: true,
    cdpEndpoint,
    novncUrl,
    extensionConnected: extension.connected,
    humanize: { level: defaultHumanizeLevel },
    platformPacing: platformPacingStatus(),
    stealth: stealthStatus(runtimeConfig?.config, tlsGateway),
    tlsGateway,
    browserRuntime: runtimeConfig?.config?.browserRuntime || null,
    runtimeConfig: runtimeConfig?.config || null,
    tabOwnership: await tabOwnershipAudit(),
    leases: store.listLeases({ activeOnly: true }).map((lease) => ({ ...lease, tabs: store.listTabs(lease.id) })),
  };
}


async function tabOwnershipAudit() {
  const openTrackedTabs = store.listTabs().filter((tab) => tab.status !== 'closed');
  const trackedById = new Map(openTrackedTabs.map((tab) => [Number(tab.id), tab]));
  const activeLeasesById = new Map(store.listLeases({ activeOnly: true }).map((lease) => [lease.id, lease]));

  const base = {
    ok: true,
    extensionConnected: extension.connected,
    actualTabs: [],
    trackedOpenTabs: openTrackedTabs,
    untrackedTabs: [],
    trackedMissingTabs: [],
    groupMismatches: [],
    summary: {
      actualTabs: 0,
      trackedOpenTabs: openTrackedTabs.length,
      untrackedTabs: 0,
      trackedMissingTabs: 0,
      groupMismatches: 0,
    },
  };

  if (!extension.connected) {
    return { ...base, ok: false, error: 'EXTENSION_NOT_CONNECTED' };
  }

  let actualTabs = [];
  try {
    const result = await extension.call('tabs.list', {}, { timeoutMs: 5000, connectTimeoutMs: 1000 });
    actualTabs = Array.isArray(result?.tabs) ? result.tabs : [];
  } catch (error) {
    app.log.warn({ error, errorMessage: error?.message }, 'tab ownership audit failed');
    return { ...base, ok: false, error: error?.message || String(error) };
  }

  const actualById = new Map(actualTabs.map((tab) => [Number(tab.id), tab]));
  const untrackedTabs = actualTabs.filter((tab) => !trackedById.has(Number(tab.id))).map(classifyActualTab);
  const trackedMissingTabs = openTrackedTabs.filter((tab) => !actualById.has(Number(tab.id)));
  const groupMismatches = [];

  for (const trackedTab of openTrackedTabs) {
    const actualTab = actualById.get(Number(trackedTab.id));
    if (!actualTab) continue;
    const lease = activeLeasesById.get(trackedTab.leaseId);
    if (lease?.chromeGroupId != null && actualTab.groupId != null && Number(actualTab.groupId) !== Number(lease.chromeGroupId)) {
      groupMismatches.push({ tab: actualTab, tracked: trackedTab, lease });
    }
  }

  return {
    ...base,
    actualTabs,
    untrackedTabs,
    trackedMissingTabs,
    groupMismatches,
    summary: {
      actualTabs: actualTabs.length,
      trackedOpenTabs: openTrackedTabs.length,
      untrackedTabs: untrackedTabs.length,
      trackedMissingTabs: trackedMissingTabs.length,
      groupMismatches: groupMismatches.length,
    },
  };
}

function classifyActualTab(tab) {
  const url = String(tab.url || '');
  const systemLike = url === '' || url === 'about:blank' || url.startsWith('chrome://') || url.startsWith('devtools://') || url.startsWith('chrome-extension://');
  return {
    ...tab,
    owner: systemLike ? 'browser/system' : 'untracked-direct-cdp-or-human',
    severity: systemLike ? 'info' : 'warning',
  };
}

async function readRuntimeConfig() {
  if (!extension.connected) return null;
  try {
    return await extension.call('runtime.config', {}, { timeoutMs: 5000, connectTimeoutMs: 1000 });
  } catch (error) {
    app.log.warn({ error, errorMessage: error?.message }, 'runtime config read failed');
    return null;
  }
}

function stealthStatus(runtimeConfig = null, tlsGateway = null) {
  const tlsProxyServer = String(process.env.BRS_TLS_GATEWAY_PROXY_SERVER || '').trim();
  const browserProxyServer = String(process.env.BROWSER_PROXY_SERVER || '').trim();
  const extraHeaders = parseJsonObject(process.env.BRS_EXTRA_HTTP_HEADERS_JSON);
  const runtimeStealth = runtimeConfig?.stealth || {};
  const fingerprint = runtimeConfig?.fingerprint || null;
  return {
    enabled: runtimeStealth.enabled ?? readEnvFlag('BRS_STEALTH_ENABLED', true),
    profile: runtimeStealth.profile || String(process.env.BRS_STEALTH_PROFILE || 'standard'),
    headersEnabled: runtimeStealth.headersEnabled ?? readEnvFlag('BRS_FINGERPRINT_HEADERS_ENABLED', true),
    patchesEnabled: runtimeStealth.patchesEnabled ?? readEnvFlag('BRS_FINGERPRINT_PATCHES_ENABLED', true),
    canvasNoise: runtimeStealth.canvasNoise ?? readEnvFlag('BRS_CANVAS_NOISE_ENABLED', true),
    audioNoise: runtimeStealth.audioNoise ?? readEnvFlag('BRS_AUDIO_NOISE_ENABLED', true),
    acceptLanguage: runtimeStealth.acceptLanguage || String(process.env.BRS_ACCEPT_LANGUAGE || 'en-US,en;q=0.9'),
    locale: runtimeStealth.locale || String(process.env.BRS_LOCALE || 'en-US'),
    timezone: runtimeStealth.timezone || String(process.env.BRS_STEALTH_TIMEZONE || process.env.BROWSER_TIMEZONE || 'UTC'),
    platform: runtimeStealth.platform || String(process.env.BRS_PLATFORM || ''),
    userAgent: runtimeStealth.userAgent ? 'configured' : (process.env.BRS_USER_AGENT ? 'configured' : 'default'),
    webgl: {
      vendor: runtimeStealth.webglVendor || String(process.env.BRS_WEBGL_VENDOR || ''),
      renderer: runtimeStealth.webglRenderer || String(process.env.BRS_WEBGL_RENDERER || ''),
    },
    hardware: {
      hardwareConcurrency: runtimeStealth.hardwareConcurrency ?? null,
      deviceMemory: runtimeStealth.deviceMemory ?? null,
      maxTouchPoints: runtimeStealth.maxTouchPoints ?? null,
    },
    fingerprint,
    extraHeaderKeys: runtimeStealth.extraHeaderKeys || Object.keys(extraHeaders),
    tlsGateway: {
      enabled: tlsGateway?.enabled ?? readEnvFlag('BRS_TLS_GATEWAY_ENABLED', true),
      configured: Boolean(tlsProxyServer),
      active: tlsGateway?.active ?? Boolean(readEnvFlag('BRS_TLS_GATEWAY_ENABLED', true) && tlsProxyServer && !browserProxyServer),
      healthOk: tlsGateway?.health?.ok ?? null,
    },
  };
}

async function enforcePlatformCooldown(platform, body = {}) {
  if (body.cooldown === false || body.platformCooldown === false) return { enabled: false, skipped: true, reason: 'request-disabled' };
  if (!readEnvFlag('BRS_PLATFORM_COOLDOWN_ENABLED', true)) return { enabled: false, skipped: true, reason: 'env-disabled' };
  const cooldownSeconds = platformCooldownSeconds(platform);
  if (cooldownSeconds <= 0) return { enabled: true, platform, cooldownSeconds, waitedMs: 0 };
  const key = String(platform || 'generic').toLowerCase();
  const now = Date.now();
  const last = platformLastActionAt.get(key) || 0;
  const waitMs = Math.max(0, last + cooldownSeconds * 1000 - now);
  if (waitMs > 0) {
    if (String(body.cooldownMode || 'wait').toLowerCase() === 'reject') {
      return { enabled: true, platform: key, cooldownSeconds, waitMs, rejected: true };
    }
    await sleep(waitMs);
  }
  platformLastActionAt.set(key, Date.now());
  return { enabled: true, platform: key, cooldownSeconds, waitedMs: waitMs };
}

function platformPacingStatus() {
  const platforms = ['reddit', 'facebook', 'linkedin', 'instagram', 'manualChallenge'];
  return {
    enabled: readEnvFlag('BRS_PLATFORM_COOLDOWN_ENABLED', true),
    cooldownSeconds: Object.fromEntries(platforms.map((platform) => [platform, platformCooldownSeconds(platform)])),
    lastActionAt: Object.fromEntries(Array.from(platformLastActionAt.entries()).map(([platform, timestamp]) => [platform, new Date(timestamp).toISOString()])),
  };
}

function platformCooldownSeconds(platform) {
  const key = String(platform || 'generic').toLowerCase().replace(/[^a-z0-9]/g, '_');
  const defaults = {
    reddit: 45,
    facebook: 60,
    linkedin: 180,
    instagram: 240,
    manualchallenge: 300,
    manual_challenge: 300,
    generic: 0,
  };
  const envName = `BRS_PLATFORM_COOLDOWN_${key.toUpperCase()}_SECONDS`;
  return readNonNegativeNumber(process.env[envName], defaults[key] ?? 0);
}

async function tlsGatewayStatus() {
  const enabled = readEnvFlag('BRS_TLS_GATEWAY_ENABLED', true);
  const proxyServer = String(process.env.BRS_TLS_GATEWAY_PROXY_SERVER || '').trim();
  const browserProxyServer = String(process.env.BROWSER_PROXY_SERVER || '').trim();
  const baseUrl = String(process.env.BRS_TLS_GATEWAY_BASE_URL || process.env.TLS_GATEWAY_BASE_URL || '').trim();
  const healthUrl = String(process.env.BRS_TLS_GATEWAY_HEALTH_URL || '').trim() || gatewayUrl(baseUrl, process.env.BRS_TLS_GATEWAY_HEALTH_PATH || '/health');
  const statsUrl = String(process.env.BRS_TLS_GATEWAY_STATS_URL || '').trim() || gatewayUrl(baseUrl, process.env.BRS_TLS_GATEWAY_STATS_PATH || '/stats');
  const timeoutMs = readPositiveNumber(process.env.BRS_TLS_GATEWAY_TIMEOUT_MS, 1500);
  const status = {
    enabled,
    proxyConfigured: Boolean(proxyServer),
    baseConfigured: Boolean(baseUrl),
    active: Boolean(enabled && proxyServer && !browserProxyServer),
    overriddenByBrowserProxy: Boolean(browserProxyServer),
    health: { configured: Boolean(healthUrl), ok: null, url: redactUrl(healthUrl), error: null, data: null },
    stats: { configured: Boolean(statsUrl), ok: null, url: redactUrl(statsUrl), error: null, data: null },
  };
  if (!enabled) return status;
  if (healthUrl) {
    const health = await fetchJsonWithTimeout(healthUrl, timeoutMs);
    status.health = { ...status.health, ...health };
  }
  if (statsUrl) {
    const stats = await fetchJsonWithTimeout(statsUrl, timeoutMs);
    status.stats = { ...status.stats, ...stats };
  }
  return status;
}

function gatewayUrl(baseUrl, path) {
  if (!baseUrl) return null;
  try {
    return new URL(path || '/', baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).href;
  } catch {
    return null;
  }
}

async function fetchJsonWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, Number(timeoutMs) || 1));
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
    const text = await response.text();
    let data = text;
    try { data = text ? JSON.parse(text) : null; } catch {}
    return { ok: response.ok, status: response.status, data, error: response.ok ? null : `HTTP_${response.status}` };
  } catch (error) {
    return { ok: false, status: null, data: null, error: error?.name === 'AbortError' ? 'TIMEOUT' : (error?.message || String(error)) };
  } finally {
    clearTimeout(timer);
  }
}

function redactUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.username) url.username = '***';
    if (url.password) url.password = '***';
    return url.toString();
  } catch {
    return null;
  }
}

function defaultPlatformUrl(platform) {
  const urls = {
    linkedin: 'https://www.linkedin.com/feed/',
    reddit: 'https://www.reddit.com/',
    facebook: 'https://www.facebook.com/',
    instagram: 'https://www.instagram.com/',
    generic: 'https://example.com/',
  };
  return urls[String(platform || '').toLowerCase()] || urls.generic;
}

function readEnvFlag(name, fallback = true) {
  const value = process.env[name];
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function parseJsonObject(value) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function colorFor(seed) {
  const colors = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];
  let hash = 0;
  for (const ch of String(seed)) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return colors[hash % colors.length];
}

await app.listen({ host, port });
