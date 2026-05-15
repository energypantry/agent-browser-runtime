// Browser Runtime Skill Companion Extension
// Source of truth lives in broker. This extension only executes Chrome-native ops.

try { importScripts('runtime-config.js'); } catch (_) {}

const BROKER_WS = globalThis.BRS_CONFIG?.brokerWs || 'ws://broker:17890/extension';
const CDP_VERSION = '1.3';
const KEEPALIVE_INTERVAL_MS = 20000;
const attachedTabs = new Set();
const lastMousePointByTab = new Map();
let socket = null;
let reconnectTimer = null;
let keepaliveTimer = null;

function log(...args) { console.log('[BRS]', ...args); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function send(payload) {
  try {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
  } catch (error) {
    console.warn('[BRS] send failed', error);
  }
}

function connect() {
  clearTimeout(reconnectTimer);
  try {
    socket = new WebSocket(BROKER_WS);
    socket.onopen = () => {
      send({ jsonrpc: '2.0', method: 'extension.connected', params: { at: new Date().toISOString() } });
      startKeepalive();
    };
    socket.onmessage = async (event) => {
      let request;
      try {
        request = JSON.parse(event.data);
        const result = await dispatch(request.method, request.params || {});
        send({ jsonrpc: '2.0', id: request.id, result });
      } catch (error) {
        send({ jsonrpc: '2.0', id: request?.id, error: { code: -32000, message: error?.message || String(error) } });
      }
    };
    socket.onclose = () => {
      stopKeepalive();
      scheduleReconnect();
    };
    socket.onerror = () => { try { socket.close(); } catch (_) {} };
  } catch (_) {
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, 3000);
}

function startKeepalive() {
  stopKeepalive();
  keepaliveTimer = setInterval(() => {
    send({ jsonrpc: '2.0', method: 'extension.keepalive', params: { at: new Date().toISOString() } });
  }, KEEPALIVE_INTERVAL_MS);
}

function stopKeepalive() {
  clearInterval(keepaliveTimer);
  keepaliveTimer = null;
}

async function dispatch(method, params) {
  switch (method) {
    case 'ping': return { ok: true, at: new Date().toISOString() };
    case 'tabs.create': return tabsCreate(params);
    case 'tabs.close': return tabsClose(params);
    case 'tabs.navigate': return tabsNavigate(params);
    case 'tabs.get': return tabsGet(params);
    case 'tabs.list': return tabsList(params);
    case 'group.update': return groupUpdate(params);
    case 'cdp.execute': return cdpExecute(params);
    case 'page.html': return pageHtml(params);
    case 'screenshot.capture': return screenshotCapture(params);
    case 'humanize.warmup': return humanizeWarmup(params);
    case 'humanize.scroll': return humanizeScroll(params);
    case 'humanize.pause': return humanizePause(params);
    default: throw new Error(`Unsupported method: ${method}`);
  }
}

async function tabsCreate(params) {
  const tab = await chrome.tabs.create({ active: Boolean(params.active), url: params.url || 'about:blank' });
  if (!tab.id) throw new Error('Chrome did not return a tab id');
  const chromeGroupId = await groupTab(tab.id, params.groupId);
  await chrome.tabGroups.update(chromeGroupId, {
    title: params.groupTitle || 'agent-task',
    color: normalizeColor(params.groupColor),
    collapsed: false,
  });
  if (params.waitUntilCompleteMs !== 0) await waitForTabComplete(tab.id, params.waitUntilCompleteMs || 15000).catch(() => {});
  return { chromeGroupId, tab: normalizeTab(await chrome.tabs.get(tab.id)) };
}

async function groupTab(tabId, requestedGroupId) {
  if (requestedGroupId == null || requestedGroupId === '') return chrome.tabs.group({ tabIds: [tabId] });
  const groupId = Number(requestedGroupId);
  if (Number.isInteger(groupId) && groupId >= 0) {
    try {
      return await chrome.tabs.group({ groupId, tabIds: [tabId] });
    } catch (error) {
      if (!isMissingGroupError(error)) throw error;
    }
  }
  return chrome.tabs.group({ tabIds: [tabId] });
}

function isMissingGroupError(error) {
  const message = String(error?.message || error);
  return message.includes('No group with id') || message.includes('Invalid group id');
}

async function tabsClose(params) {
  const tabId = Number(params.tabId);
  await detachDebugger(tabId).catch(() => {});
  await chrome.tabs.remove(tabId);
  return { ok: true, tabId };
}

async function tabsNavigate(params) {
  const tabId = Number(params.tabId);
  if (!params.url) throw new Error('url is required');
  await chrome.tabs.update(tabId, { url: params.url, active: Boolean(params.active) });
  if (params.waitUntilCompleteMs !== 0) await waitForTabComplete(tabId, params.waitUntilCompleteMs || 15000).catch(() => {});
  return { tab: normalizeTab(await chrome.tabs.get(tabId)) };
}

async function tabsGet(params) {
  return { tab: normalizeTab(await chrome.tabs.get(Number(params.tabId))) };
}

async function tabsList() {
  const tabs = await chrome.tabs.query({});
  return { tabs: tabs.map(normalizeTab) };
}

async function groupUpdate(params) {
  const patch = {};
  if (params.title) patch.title = params.title;
  if (params.color) patch.color = normalizeColor(params.color);
  if (typeof params.collapsed === 'boolean') patch.collapsed = params.collapsed;
  return chrome.tabGroups.update(Number(params.chromeGroupId), patch);
}

async function cdpExecute(params) {
  const tabId = Number(params.tabId);
  await attachDebugger(tabId);
  return chrome.debugger.sendCommand({ tabId }, params.method, params.params || {});
}

async function pageHtml(params) {
  const tabId = Number(params.tabId);
  await attachDebugger(tabId);
  const result = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
    expression: 'document.documentElement ? document.documentElement.outerHTML : document.body?.outerHTML || ""',
    returnByValue: true,
    awaitPromise: true,
  });
  return { html: result?.result?.value || '', tab: normalizeTab(await chrome.tabs.get(tabId)) };
}

async function screenshotCapture(params) {
  const tabId = Number(params.tabId);
  await attachDebugger(tabId);
  await chrome.debugger.sendCommand({ tabId }, 'Page.enable', {}).catch(() => {});
  const format = params.format === 'png' ? 'png' : 'jpeg';
  const result = await chrome.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', {
    format,
    quality: format === 'jpeg' ? Number(params.quality || 80) : undefined,
    captureBeyondViewport: Boolean(params.fullPage),
  });
  return { data: result.data, format };
}


async function humanizeWarmup(params) {
  const tabId = Number(params.tabId);
  await chrome.tabs.update(tabId, { active: true }).catch(() => {});
  const policy = normalizeHumanizePolicy(params.policy || {});
  if (policy.level === 'off') return { ok: true, skipped: true, reason: 'humanize off' };

  const vp = await viewportInfo(tabId);
  const targetA = { x: randomInt(80, Math.floor(vp.width * 0.8)), y: randomInt(80, Math.floor(vp.height * 0.8)) };
  const targetB = { x: randomInt(80, Math.floor(vp.width * 0.8)), y: randomInt(80, Math.floor(vp.height * 0.8)) };
  await ghostMove(tabId, targetA, policy);
  await humanSleep(90, 220, policy);
  await ghostMove(tabId, targetB, policy);
  await humanSleep(120, 300, policy);
  await dispatchWheel(tabId, randomInt(120, 320));
  await humanSleep(120, 260, policy);
  await dispatchWheel(tabId, -randomInt(80, 220));
  return { ok: true, action: 'warmup', level: policy.level };
}

async function humanizeScroll(params) {
  const tabId = Number(params.tabId);
  await chrome.tabs.update(tabId, { active: true }).catch(() => {});
  const policy = normalizeHumanizePolicy(params.policy || {});
  if (policy.level === 'off') return { ok: true, skipped: true, reason: 'humanize off' };

  const direction = params.direction === 'up' ? -1 : 1;
  const count = Math.max(1, Math.min(12, Number(params.count || randomInt(policy.scrollCountMin, policy.scrollCountMax))));
  for (let i = 0; i < count; i += 1) {
    const delta = direction * randomInt(policy.scrollDeltaMin, policy.scrollDeltaMax);
    await dispatchWheel(tabId, delta);
    await humanSleep(policy.scrollPauseMinMs, policy.scrollPauseMaxMs, policy);
    if (Math.random() < policy.microRestProbability) await humanSleep(policy.microRestMinMs, policy.microRestMaxMs, policy);
  }
  return { ok: true, action: 'scroll', count, level: policy.level };
}

async function humanizePause(params) {
  const policy = normalizeHumanizePolicy(params.policy || {});
  if (policy.level === 'off') return { ok: true, skipped: true, reason: 'humanize off' };
  const minMs = Number(params.minMs || policy.actionPauseMinMs);
  const maxMs = Number(params.maxMs || policy.actionPauseMaxMs);
  const sleptMs = await humanSleep(minMs, maxMs, policy);
  return { ok: true, action: 'pause', sleptMs, level: policy.level };
}

function normalizeHumanizePolicy(policy) {
  const level = String(policy.level || 'standard').toLowerCase();
  const multiplier = level === 'enhanced' ? 1.35 : level === 'minimal' ? 0.55 : 1;
  return {
    level,
    actionPauseMinMs: Number(policy.actionPauseMinMs || 180),
    actionPauseMaxMs: Number(policy.actionPauseMaxMs || 700),
    scrollCountMin: Number(policy.scrollCountMin || 1),
    scrollCountMax: Number(policy.scrollCountMax || 3),
    scrollDeltaMin: Number(policy.scrollDeltaMin || 260),
    scrollDeltaMax: Number(policy.scrollDeltaMax || 900),
    scrollPauseMinMs: Number(policy.scrollPauseMinMs || 380),
    scrollPauseMaxMs: Number(policy.scrollPauseMaxMs || 1200),
    microRestProbability: Number(policy.microRestProbability ?? 0.18),
    microRestMinMs: Number(policy.microRestMinMs || 900),
    microRestMaxMs: Number(policy.microRestMaxMs || 2200),
    mousePauseMultiplier: Number(policy.mousePauseMultiplier || multiplier),
  };
}

async function viewportInfo(tabId) {
  const [frameResult] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => ({ width: window.innerWidth || 1280, height: window.innerHeight || 800, x: window.scrollX || 0, y: window.scrollY || 0 }),
  });
  return frameResult?.result || { width: 1280, height: 800, x: 0, y: 0 };
}

function ensureStartPoint(tabId, vp) {
  if (!lastMousePointByTab.has(tabId)) {
    lastMousePointByTab.set(tabId, {
      x: randomInt(Math.floor(vp.width * 0.2), Math.floor(vp.width * 0.8)),
      y: randomInt(Math.floor(vp.height * 0.2), Math.floor(vp.height * 0.8)),
    });
  }
  return lastMousePointByTab.get(tabId);
}

async function ghostMove(tabId, to, policy) {
  const vp = await viewportInfo(tabId);
  const from = ensureStartPoint(tabId, vp);
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  const steps = Math.max(8, Math.min(28, Math.floor(distance / randomFloat(18, 32))));
  let points = curvePoints(from, to, steps).map((point) => ({
    x: Math.max(0, Math.round(point.x)),
    y: Math.max(0, Math.round(point.y)),
  }));
  if (policy.level === 'enhanced') points = applyAcceleration(points, randomFloat(0.6, 1.2)).map((point) => ({
    x: Math.max(0, Math.round(point.x)),
    y: Math.max(0, Math.round(point.y)),
  }));

  await chrome.scripting.executeScript({
    target: { tabId },
    args: [points],
    func: (pointsArg) => {
      for (const p of pointsArg) {
        const target = document.elementFromPoint(p.x, p.y) || document.body || document.documentElement;
        if (target) target.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: p.x, clientY: p.y, screenX: p.x, screenY: p.y, view: window }));
        window.__BRS_LAST_MOUSE__ = { x: p.x, y: p.y, at: Date.now() };
      }
      return window.__BRS_LAST_MOUSE__ || null;
    },
  }).catch(() => {});
  lastMousePointByTab.set(tabId, { x: to.x, y: to.y });
}

async function dispatchMouseMoved(tabId, x, y) {
  const safeX = Math.max(0, Math.round(x));
  const safeY = Math.max(0, Math.round(y));
  await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
    expression: `(() => {
      const x = ${safeX};
      const y = ${safeY};
      const target = document.elementFromPoint(x, y) || document.body || document.documentElement;
      if (!target) return false;
      target.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: x, clientY: y, screenX: x, screenY: y, view: window }));
      window.__BRS_LAST_MOUSE__ = { x, y, at: Date.now() };
      return true;
    })()`,
    returnByValue: true,
    awaitPromise: true,
  }).catch(() => {});
}

async function dispatchWheel(tabId, deltaY) {
  const vp = await viewportInfo(tabId);
  const point = ensureStartPoint(tabId, vp);
  const safeX = Math.max(1, Math.round(point.x));
  const safeY = Math.max(1, Math.round(point.y));
  const safeDeltaY = Math.round(Number(deltaY));
  await chrome.scripting.executeScript({
    target: { tabId },
    args: [safeX, safeY, safeDeltaY],
    func: (x, y, deltaYArg) => {
      const target = document.elementFromPoint(x, y) || document.scrollingElement || document.documentElement;
      if (target) target.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: x, clientY: y, deltaY: deltaYArg }));
      window.scrollBy({ top: deltaYArg, left: 0, behavior: 'auto' });
      window.__BRS_LAST_SCROLL__ = { x: window.scrollX || 0, y: window.scrollY || 0, deltaY: deltaYArg, at: Date.now() };
      return window.__BRS_LAST_SCROLL__;
    },
  }).catch(() => {});
}

function cubicBezier(p0, p1, p2, p3, t) {
  const mt = 1 - t;
  return (mt ** 3) * p0 + 3 * (mt ** 2) * t * p1 + 3 * mt * (t ** 2) * p2 + (t ** 3) * p3;
}

function curvePoints(from, to, steps) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const curveStrength = Math.max(22, Math.min(140, Math.hypot(dx, dy) * 0.22));
  const c1 = {
    x: from.x + dx * randomFloat(0.18, 0.42) + randomFloat(-curveStrength, curveStrength),
    y: from.y + dy * randomFloat(0.18, 0.42) + randomFloat(-curveStrength, curveStrength),
  };
  const c2 = {
    x: from.x + dx * randomFloat(0.58, 0.82) + randomFloat(-curveStrength, curveStrength),
    y: from.y + dy * randomFloat(0.58, 0.82) + randomFloat(-curveStrength, curveStrength),
  };
  return Array.from({ length: steps }, (_, index) => {
    const t = (index + 1) / steps;
    return { x: cubicBezier(from.x, c1.x, c2.x, to.x, t), y: cubicBezier(from.y, c1.y, c2.y, to.y, t) };
  });
}

function applyAcceleration(points, speedFactor = 1.0) {
  if (points.length < 3) return points;
  const result = [points[0]];
  for (let i = 1; i < points.length - 1; i += 1) {
    result.push({
      x: points[i].x + (Math.random() - 0.5) * 3 * speedFactor,
      y: points[i].y + (Math.random() - 0.5) * 3 * speedFactor,
    });
  }
  result.push(points[points.length - 1]);
  return result;
}

async function humanSleep(minMs = 80, maxMs = 260) {
  const min = Math.max(0, Math.floor(Number(minMs)));
  const max = Math.max(min, Math.floor(Number(maxMs)));
  const ms = randomInt(min, max);
  await sleep(ms);
  return ms;
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomFloat(min, max) {
  return Math.random() * (max - min) + min;
}

async function attachDebugger(tabId) {
  if (attachedTabs.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, CDP_VERSION);
    attachedTabs.add(tabId);
  } catch (error) {
    if (String(error?.message || error).includes('Another debugger')) {
      attachedTabs.add(tabId);
      return;
    }
    throw error;
  }
}

async function detachDebugger(tabId) {
  if (!attachedTabs.has(tabId)) return;
  try { await chrome.debugger.detach({ tabId }); } catch (_) {}
  attachedTabs.delete(tabId);
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error(`Timed out waiting for tab ${tabId}`));
    }, timeoutMs);
    const listener = (updatedTabId, changeInfo, tab) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(tab);
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(tab);
      }
    }).catch(() => {});
  });
}

function normalizeTab(tab) {
  return {
    id: tab.id,
    windowId: tab.windowId,
    title: tab.title || '',
    url: tab.url || '',
    active: Boolean(tab.active),
    status: tab.status,
    groupId: tab.groupId,
  };
}

function normalizeColor(color) {
  const allowed = new Set(['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange']);
  return allowed.has(color) ? color : 'blue';
}

connect();
chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => send({ jsonrpc: '2.0', method: 'extension.keepalive', params: { at: new Date().toISOString() } }));
