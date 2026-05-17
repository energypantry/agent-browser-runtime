// Agent Browser Runtime Companion Extension
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
    case 'runtime.config': return runtimeConfig();
    case 'tabs.create': return tabsCreate(params);
    case 'tabs.close': return tabsClose(params);
    case 'tabs.navigate': return tabsNavigate(params);
    case 'tabs.get': return tabsGet(params);
    case 'tabs.list': return tabsList(params);
    case 'group.update': return groupUpdate(params);
    case 'cdp.execute': return cdpExecute(params);
    case 'page.html': return pageHtml(params);
    case 'screenshot.capture': return screenshotCapture(params);
    case 'session.probe': return sessionProbe(params);
    case 'humanize.warmup': return humanizeWarmup(params);
    case 'humanize.scroll': return humanizeScroll(params);
    case 'humanize.pause': return humanizePause(params);
    case 'ui.move': return uiMove(params);
    case 'ui.click': return uiClick(params);
    case 'ui.type': return uiType(params);
    case 'ui.press': return uiPress(params);
    case 'ui.scroll': return uiScroll(params);
    case 'ui.waitFor': return uiWaitFor(params);
    default: throw new Error(`Unsupported method: ${method}`);
  }
}

async function tabsCreate(params) {
  const targetUrl = params.url || 'about:blank';
  const shouldPrepareTab = shouldApplyStealthOverrides(targetUrl);
  const tab = await chrome.tabs.create({ active: Boolean(params.active), url: shouldPrepareTab ? 'about:blank' : targetUrl });
  if (!tab.id) throw new Error('Chrome did not return a tab id');
  const chromeGroupId = await groupTab(tab.id, params.groupId);
  await chrome.tabGroups.update(chromeGroupId, {
    title: params.groupTitle || 'agent-task',
    color: normalizeColor(params.groupColor),
    collapsed: false,
  });
  if (shouldPrepareTab) {
    await applyStealthCdpOverrides(tab.id).catch((error) => console.warn('[BRS] stealth CDP overrides failed', error));
    await chrome.tabs.update(tab.id, { url: targetUrl, active: Boolean(params.active) });
  }
  if (params.waitUntilCompleteMs !== 0) await waitForTabComplete(tab.id, params.waitUntilCompleteMs || 15000, targetUrl).catch(() => {});
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
  if (shouldApplyStealthOverrides(params.url)) {
    await applyStealthCdpOverrides(tabId).catch((error) => console.warn('[BRS] stealth CDP overrides failed', error));
  }
  await chrome.tabs.update(tabId, { url: params.url, active: Boolean(params.active) });
  if (params.waitUntilCompleteMs !== 0) await waitForTabComplete(tabId, params.waitUntilCompleteMs || 15000, params.url).catch(() => {});
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

function stealthPolicy() {
  return globalThis.BRS_CONFIG?.stealth || {};
}

function shouldApplyStealthOverrides(url) {
  const policy = stealthPolicy();
  if (!policy.enabled) return false;
  if (!url || url === 'about:blank' || url.startsWith('chrome://') || url.startsWith('chrome-extension://')) return false;
  if (isStealthExcludedUrl(url, policy)) return false;
  const extraHeaders = policy.extraHeaders && typeof policy.extraHeaders === 'object' ? policy.extraHeaders : {};
  return Boolean(
    (policy.headersEnabled && policy.acceptLanguage) ||
    Object.keys(extraHeaders).length > 0 ||
    policy.userAgent ||
    policy.locale ||
    policy.timezone ||
    policy.platform
  );
}

function isStealthExcludedUrl(url, policy = stealthPolicy()) {
  const excludedHosts = Array.isArray(policy.excludedHosts) ? policy.excludedHosts : [];
  if (!excludedHosts.length) return false;
  try {
    const hostname = new URL(url).hostname;
    return excludedHosts.some((pattern) => hostMatches(hostname, pattern));
  } catch {
    return false;
  }
}

function hostMatches(hostname, pattern) {
  const host = String(hostname || '').toLowerCase();
  const rule = String(pattern || '').trim().toLowerCase();
  if (!host || !rule) return false;
  if (rule.startsWith('*.')) {
    const suffix = rule.slice(1);
    return host.endsWith(suffix) && host !== suffix.slice(1);
  }
  return host === rule || host.endsWith(`.${rule}`);
}

async function applyStealthCdpOverrides(tabId) {
  const policy = stealthPolicy();
  if (!policy.enabled) return null;
  await attachDebugger(tabId);
  await chrome.debugger.sendCommand({ tabId }, 'Network.enable', {}).catch(() => {});

  const headers = { ...(policy.extraHeaders || {}) };
  if (policy.headersEnabled && policy.acceptLanguage && !headers['Accept-Language']) {
    headers['Accept-Language'] = String(policy.acceptLanguage);
  }
  if (Object.keys(headers).length > 0) {
    await chrome.debugger.sendCommand({ tabId }, 'Network.setExtraHTTPHeaders', { headers }).catch(() => {});
  }

  if (policy.userAgent || policy.acceptLanguage || policy.platform) {
    const override = {};
    if (policy.userAgent) override.userAgent = String(policy.userAgent);
    if (policy.acceptLanguage) override.acceptLanguage = String(policy.acceptLanguage);
    if (policy.platform) override.platform = String(policy.platform);
    if (policy.userAgentMetadata && typeof policy.userAgentMetadata === 'object') override.userAgentMetadata = policy.userAgentMetadata;
    if (override.userAgent) await chrome.debugger.sendCommand({ tabId }, 'Network.setUserAgentOverride', override).catch(() => {});
  }

  if (policy.timezone) {
    await chrome.debugger.sendCommand({ tabId }, 'Emulation.setTimezoneOverride', { timezoneId: String(policy.timezone) }).catch(() => {});
  }
  if (policy.locale) {
    await chrome.debugger.sendCommand({ tabId }, 'Emulation.setLocaleOverride', { locale: String(policy.locale) }).catch(() => {});
  }
  return { ok: true };
}

function runtimeConfig() {
  const config = cloneJson(globalThis.BRS_CONFIG || {});
  if (config?.stealth?.extraHeaders) {
    config.stealth.extraHeaderKeys = Object.keys(config.stealth.extraHeaders);
    delete config.stealth.extraHeaders;
  }
  if (config?.stealth?.tlsGateway && Object.prototype.hasOwnProperty.call(config.stealth.tlsGateway, 'proxyServer')) {
    config.stealth.tlsGateway.configured = Boolean(config.stealth.tlsGateway.proxyServer);
    delete config.stealth.tlsGateway.proxyServer;
  }
  return { config };
}

async function sessionProbe(params) {
  const tabId = Number(params.tabId);
  const platform = String(params.platform || 'generic').toLowerCase();
  const policy = platformProbePolicy(platform);
  if (params.url) {
    await tabsNavigate({
      tabId,
      url: String(params.url),
      waitUntilCompleteMs: params.waitUntilCompleteMs ?? 15000,
    });
  }
  await attachDebugger(tabId);
  await chrome.debugger.sendCommand({ tabId }, 'Network.enable', {}).catch(() => {});
  const [tab, cookiesResult, page] = await Promise.all([
    chrome.tabs.get(tabId).then(normalizeTab),
    chrome.debugger.sendCommand({ tabId }, 'Network.getAllCookies', {}).catch(() => ({ cookies: [] })),
    probePageState(tabId, policy),
  ]);
  const cookies = filterProbeCookies(cookiesResult?.cookies || [], policy, tab.url);
  const cookieNames = [...new Set(cookies.map((cookie) => cookie.name))].sort();
  const authCookieNames = cookieNames.filter((name) => policy.authCookies.includes(name));
  const challenge = Boolean(page.challengeMatched || matchesAny(tab.url, policy.challengeUrlIncludes));
  const loginRequired = Boolean(page.loginSelectorMatched || matchesAny(tab.url, policy.loginUrlIncludes));
  const connected = authCookieNames.length > 0 && !challenge && !loginRequired;
  const reason = connected
    ? 'auth-cookie'
    : challenge
      ? 'challenge-detected'
      : loginRequired
        ? 'login-required'
        : authCookieNames.length
          ? 'auth-cookie-needs-verification'
          : 'no-auth-cookie';
  return {
    platform,
    connected,
    reason,
    errorCode: connected ? null : reason.toUpperCase().replace(/-/g, '_'),
    currentUrl: tab.url,
    title: tab.title,
    cookieNames,
    authCookieNames,
    expiresAt: cookieExpiresAt(cookies),
    page,
    cookies: params.includeCookies ? cookies.map(normalizeCookie) : undefined,
    storageState: params.includeStorageState ? await buildStorageState(tabId, cookies) : undefined,
  };
}

function platformProbePolicy(platform) {
  const policies = {
    linkedin: {
      domains: ['linkedin.com', '.linkedin.com'],
      authCookies: ['li_at'],
      loginUrlIncludes: ['/login', '/uas/login', '/checkpoint/lg/login'],
      challengeUrlIncludes: ['/checkpoint/', '/challenge/', '/captcha'],
      loginSelectors: [
        'input[name="session_key"]',
        'input[name="session_password"]',
        'form[action*="login"]',
        'a[href*="/login"]',
      ],
      challengeText: ['security verification', 'verify your identity', 'captcha', 'checkpoint'],
    },
    reddit: {
      domains: ['reddit.com', '.reddit.com', 'www.reddit.com'],
      authCookies: ['reddit_session', 'token_v2'],
      loginUrlIncludes: ['/login', '/account/login'],
      challengeUrlIncludes: ['/captcha'],
      loginSelectors: ['input[name="username"]', 'input[name="password"]', 'shreddit-signup-drawer', 'auth-flow-modal'],
      challengeText: ['prove you are human', 'captcha', 'verify'],
    },
    facebook: {
      domains: ['facebook.com', '.facebook.com'],
      authCookies: ['c_user', 'xs'],
      loginUrlIncludes: ['/login', '/checkpoint/block'],
      challengeUrlIncludes: ['/checkpoint', '/captcha'],
      loginSelectors: ['input[name="email"]', 'input[name="pass"]', 'form[action*="login"]'],
      challengeText: ['security check', 'confirm your identity', 'captcha', 'checkpoint'],
    },
    instagram: {
      domains: ['instagram.com', '.instagram.com'],
      authCookies: ['sessionid', 'ds_user_id'],
      loginUrlIncludes: ['/accounts/login'],
      challengeUrlIncludes: ['/challenge/', '/captcha'],
      loginSelectors: ['input[name="username"]', 'input[name="password"]', 'form[action*="/accounts/login"]'],
      challengeText: ['suspicious login attempt', 'challenge required', 'captcha', 'verify'],
    },
    generic: {
      domains: [],
      authCookies: [],
      loginUrlIncludes: ['/login', '/signin', '/sign-in'],
      challengeUrlIncludes: ['/captcha', '/challenge'],
      loginSelectors: ['input[type="password"]'],
      challengeText: ['captcha', 'verify you are human', 'security verification'],
    },
  };
  return policies[platform] || policies.generic;
}

async function probePageState(tabId, policy) {
  const expression = `(() => {
    const loginSelectors = ${JSON.stringify(policy.loginSelectors || [])};
    const challengeText = ${JSON.stringify(policy.challengeText || [])};
    const text = ((document.body && document.body.innerText) || '').toLowerCase().slice(0, 120000);
    const visible = (element) => {
      if (!element) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const matchedSelector = loginSelectors.find((selector) => {
      try { return Array.from(document.querySelectorAll(selector)).some(visible); }
      catch (_) { return false; }
    }) || null;
    const matchedText = challengeText.find((needle) => text.includes(String(needle).toLowerCase())) || null;
    return {
      url: location.href,
      title: document.title || '',
      readyState: document.readyState,
      loginSelectorMatched: matchedSelector,
      challengeMatched: matchedText,
      forms: document.forms ? document.forms.length : 0,
      passwordInputs: document.querySelectorAll('input[type="password"]').length,
    };
  })()`;
  const result = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  }).catch((error) => ({ result: { value: { error: error?.message || String(error) } } }));
  return result?.result?.value || {};
}

function filterProbeCookies(cookies, policy, currentUrl) {
  let domains = policy.domains || [];
  if (!domains.length && currentUrl) {
    try {
      const hostname = new URL(currentUrl).hostname;
      domains = [hostname, `.${hostname}`];
    } catch (_) {}
  }
  if (!domains.length) return [];
  return cookies.filter((cookie) => domains.some((domain) => cookie.domain === domain || cookie.domain.endsWith(domain) || domain.endsWith(cookie.domain)));
}

function normalizeCookie(cookie) {
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    expires: cookie.expires,
    httpOnly: Boolean(cookie.httpOnly),
    secure: Boolean(cookie.secure),
    sameSite: cookie.sameSite || null,
  };
}

async function buildStorageState(tabId, cookies) {
  const originResult = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
    expression: `(() => {
      const readStorage = (storage) => {
        const rows = [];
        try {
          for (let index = 0; index < storage.length; index += 1) {
            const name = storage.key(index);
            rows.push({ name, value: storage.getItem(name) });
          }
        } catch (_) {}
        return rows;
      };
      return {
        origin: location.origin,
        localStorage: readStorage(window.localStorage),
        sessionStorage: readStorage(window.sessionStorage),
      };
    })()`,
    returnByValue: true,
    awaitPromise: true,
  }).catch(() => ({ result: { value: null } }));
  const origin = originResult?.result?.value;
  const origins = origin?.origin && origin.origin !== 'null'
    ? [{
      origin: origin.origin,
      localStorage: origin.localStorage || [],
      sessionStorage: origin.sessionStorage || [],
    }]
    : [];
  return {
    cookies: cookies.map(normalizeCookie),
    origins,
  };
}

function cookieExpiresAt(cookies) {
  const expiries = cookies
    .map((cookie) => Number(cookie.expires || 0))
    .filter((expires) => Number.isFinite(expires) && expires > 0);
  if (!expiries.length) return null;
  return new Date(Math.min(...expiries) * 1000).toISOString();
}

function matchesAny(value, needles) {
  const text = String(value || '').toLowerCase();
  return (needles || []).some((needle) => text.includes(String(needle).toLowerCase()));
}

function cloneJson(value) {
  try {
    return JSON.parse(JSON.stringify(value || {}));
  } catch (_) {
    return {};
  }
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

async function uiMove(params) {
  const tabId = Number(params.tabId);
  const point = await resolveUiPoint(tabId, params);
  await realMouseMove(tabId, point, Number(params.durationMs || 280));
  return { ok: true, action: 'move', point };
}

async function uiClick(params) {
  const tabId = Number(params.tabId);
  const point = await resolveUiPoint(tabId, params);
  await realMouseMove(tabId, point, Number(params.moveDurationMs || params.durationMs || 320));
  await attachDebugger(tabId);
  const button = normalizeMouseButton(params.button);
  const clickCount = Math.max(1, Math.min(3, Number(params.clickCount || 1)));
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: point.x,
    y: point.y,
    button,
    clickCount,
  });
  await sleep(Math.max(20, Math.min(250, Number(params.holdMs || 55))));
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: point.x,
    y: point.y,
    button,
    clickCount,
  });
  return { ok: true, action: 'click', point, button, clickCount };
}

async function uiType(params) {
  const tabId = Number(params.tabId);
  const text = String(params.text ?? '');
  if (!text && params.text !== '') throw new Error('text is required');
  if (params.selector || params.textSelector || params.targetText || isFinitePoint(params)) {
    await uiClick({ ...params, clickCount: 1 });
  }
  await attachDebugger(tabId);
  const minDelayMs = Math.max(0, Number(params.minDelayMs ?? 35));
  const maxDelayMs = Math.max(minDelayMs, Number(params.maxDelayMs ?? 140));
  for (const char of text) {
    await chrome.debugger.sendCommand({ tabId }, 'Input.insertText', { text: char });
    if (maxDelayMs > 0) await sleep(randomInt(minDelayMs, maxDelayMs));
  }
  return { ok: true, action: 'type', length: text.length };
}

async function uiPress(params) {
  const tabId = Number(params.tabId);
  const keyInfo = keyDescriptor(params.key);
  await attachDebugger(tabId);
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: keyInfo.key,
    code: keyInfo.code,
    windowsVirtualKeyCode: keyInfo.keyCode,
    nativeVirtualKeyCode: keyInfo.keyCode,
    text: keyInfo.text,
    unmodifiedText: keyInfo.text,
  });
  await sleep(Math.max(10, Math.min(220, Number(params.holdMs || 45))));
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: keyInfo.key,
    code: keyInfo.code,
    windowsVirtualKeyCode: keyInfo.keyCode,
    nativeVirtualKeyCode: keyInfo.keyCode,
  });
  return { ok: true, action: 'press', key: keyInfo.key };
}

async function uiScroll(params) {
  const tabId = Number(params.tabId);
  const vp = await viewportInfo(tabId);
  const fallback = ensureStartPoint(tabId, vp);
  const point = isFinitePoint(params) ? sanitizePoint(params.x, params.y) : fallback;
  await realMouseMove(tabId, point, Number(params.moveDurationMs || 160));
  await attachDebugger(tabId);
  const direction = params.direction === 'up' ? -1 : 1;
  const count = Math.max(1, Math.min(20, Number(params.count || 1)));
  const deltaY = Number.isFinite(Number(params.deltaY)) ? Number(params.deltaY) : direction * 520;
  for (let i = 0; i < count; i += 1) {
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: point.x,
      y: point.y,
      deltaX: Number(params.deltaX || 0),
      deltaY,
    });
    await sleep(Math.max(20, Math.min(1500, Number(params.pauseMs || randomInt(220, 680)))));
  }
  return { ok: true, action: 'scroll', point, deltaY, count };
}

async function uiWaitFor(params) {
  const tabId = Number(params.tabId);
  const timeoutMs = Math.max(1, Number(params.timeoutMs || 10000));
  const pollMs = Math.max(50, Number(params.pollMs || 250));
  const startedAt = Date.now();
  let last = null;
  while (Date.now() - startedAt <= timeoutMs) {
    last = await resolveUiTarget(tabId, params).catch((error) => ({ ok: false, error: error?.message || String(error) }));
    if (last?.found) return { ok: true, action: 'waitFor', found: true, target: last, waitedMs: Date.now() - startedAt };
    await sleep(pollMs);
  }
  return { ok: false, action: 'waitFor', found: false, target: last, waitedMs: Date.now() - startedAt };
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

async function realMouseMove(tabId, to, durationMs = 260) {
  await attachDebugger(tabId);
  const vp = await viewportInfo(tabId);
  const from = ensureStartPoint(tabId, vp);
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  const steps = Math.max(3, Math.min(32, Math.ceil(distance / 36)));
  const points = curvePoints(from, to, steps).map((point) => sanitizePoint(point.x, point.y));
  const pauseMs = Math.max(0, Math.min(200, Math.floor(Number(durationMs || 0) / Math.max(1, points.length))));
  for (const point of points) {
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: point.x,
      y: point.y,
      button: 'none',
    });
    if (pauseMs) await sleep(pauseMs);
  }
  lastMousePointByTab.set(tabId, sanitizePoint(to.x, to.y));
}

async function resolveUiPoint(tabId, params) {
  if (isFinitePoint(params)) return sanitizePoint(params.x, params.y);
  const target = await resolveUiTarget(tabId, params);
  if (!target?.found) throw new Error(target?.error || 'UI target not found');
  return sanitizePoint(target.x, target.y);
}

async function resolveUiTarget(tabId, params = {}) {
  await attachDebugger(tabId);
  const selector = params.selector || params.textSelector || null;
  const text = params.targetText || params.label || null;
  if (!selector && !text) return { found: false, error: 'selector or targetText is required' };
  const result = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
    expression: `(() => {
      const selector = ${JSON.stringify(selector)};
      const wantedText = ${JSON.stringify(text)};
      const visible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      };
      let element = selector ? document.querySelector(selector) : null;
      if (!element && wantedText) {
        const needle = String(wantedText).trim().toLowerCase();
        const matchesText = (candidate) => {
          const textValue = (candidate.innerText || candidate.value || candidate.getAttribute('aria-label') || candidate.getAttribute('title') || '').trim().toLowerCase();
          return textValue && textValue.includes(needle) && visible(candidate);
        };
        const interactive = Array.from(document.querySelectorAll('button,a,input,textarea,select,label,[role="button"],[contenteditable="true"],[tabindex]'));
        const readable = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6,p,span,div,main,section,article'));
        element = interactive.find(matchesText) || readable.find(matchesText) || null;
      }
      if (!element || !visible(element)) return { found: false };
      element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' });
      const rect = element.getBoundingClientRect();
      return {
        found: true,
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2),
        tagName: element.tagName,
        selector,
        text: (element.innerText || element.value || element.getAttribute('aria-label') || '').trim().slice(0, 160),
      };
    })()`,
    returnByValue: true,
    awaitPromise: true,
  });
  return result?.result?.value || { found: false };
}

function isFinitePoint(params = {}) {
  return Number.isFinite(Number(params.x)) && Number.isFinite(Number(params.y));
}

function sanitizePoint(x, y) {
  return { x: Math.max(0, Math.round(Number(x) || 0)), y: Math.max(0, Math.round(Number(y) || 0)) };
}

function normalizeMouseButton(button) {
  const normalized = String(button || 'left').toLowerCase();
  return ['left', 'right', 'middle', 'none'].includes(normalized) ? normalized : 'left';
}

function keyDescriptor(key) {
  const name = String(key || '').trim();
  if (!name) throw new Error('key is required');
  const map = {
    Enter: ['Enter', 'Enter', 13, '\r'],
    Tab: ['Tab', 'Tab', 9, '\t'],
    Escape: ['Escape', 'Escape', 27, ''],
    Backspace: ['Backspace', 'Backspace', 8, ''],
    Delete: ['Delete', 'Delete', 46, ''],
    ArrowDown: ['ArrowDown', 'ArrowDown', 40, ''],
    ArrowUp: ['ArrowUp', 'ArrowUp', 38, ''],
    ArrowLeft: ['ArrowLeft', 'ArrowLeft', 37, ''],
    ArrowRight: ['ArrowRight', 'ArrowRight', 39, ''],
    Space: [' ', 'Space', 32, ' '],
  };
  const entry = map[name] || (name.length === 1 ? [name, `Key${name.toUpperCase()}`, name.toUpperCase().charCodeAt(0), name] : [name, name, 0, '']);
  return { key: entry[0], code: entry[1], keyCode: entry[2], text: entry[3] };
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

function waitForTabComplete(tabId, timeoutMs, expectedUrl = null) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error(`Timed out waiting for tab ${tabId}`));
    }, timeoutMs);
    const listener = (updatedTabId, changeInfo, tab) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete' && tabUrlMatches(tab?.url, expectedUrl)) {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(tab);
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === 'complete' && tabUrlMatches(tab.url, expectedUrl)) {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(tab);
      }
    }).catch(() => {});
  });
}

function tabUrlMatches(actual, expected) {
  if (!expected || expected === 'about:blank') return true;
  try {
    const actualUrl = new URL(actual || '');
    const expectedUrl = new URL(expected);
    return actualUrl.href === expectedUrl.href ||
      `${actualUrl.origin}${actualUrl.pathname}` === `${expectedUrl.origin}${expectedUrl.pathname}` ||
      (actualUrl.origin === expectedUrl.origin && actualUrl.pathname.replace(/\/$/, '') === expectedUrl.pathname.replace(/\/$/, ''));
  } catch {
    return String(actual || '') === String(expected || '');
  }
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
