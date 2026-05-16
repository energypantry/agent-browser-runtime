(() => {
  const config = globalThis.BRS_CONFIG || {};
  const stealth = config.stealth || {};
  if (!stealth.enabled || !stealth.patchesEnabled) return;

  const hostMatches = (hostname, pattern) => {
    const host = String(hostname || '').toLowerCase();
    const rule = String(pattern || '').trim().toLowerCase();
    if (!host || !rule) return false;
    if (rule.startsWith('*.')) {
      const suffix = rule.slice(1);
      return host.endsWith(suffix) && host !== suffix.slice(1);
    }
    return host === rule || host.endsWith(`.${rule}`);
  };
  const excludedHosts = Array.isArray(stealth.excludedHosts) ? stealth.excludedHosts : [];
  if (excludedHosts.some((pattern) => hostMatches(globalThis.location?.hostname, pattern))) return;

  const defineGetter = (obj, key, getter) => {
    try {
      Object.defineProperty(obj, key, { get: getter, configurable: true });
    } catch (_) {}
  };

  const languages = Array.isArray(stealth.languages) && stealth.languages.length
    ? stealth.languages.map(String)
    : String(stealth.acceptLanguage || 'en-US,en;q=0.9')
      .split(',')
      .map((entry) => entry.split(';')[0].trim())
      .filter(Boolean);
  const primaryLanguage = languages[0] || stealth.locale || 'en-US';

  defineGetter(Navigator.prototype, 'webdriver', () => undefined);
  defineGetter(Navigator.prototype, 'languages', () => languages.slice());
  defineGetter(Navigator.prototype, 'language', () => primaryLanguage);
  if (stealth.platform) defineGetter(Navigator.prototype, 'platform', () => String(stealth.platform));
  if (stealth.userAgent) defineGetter(Navigator.prototype, 'userAgent', () => String(stealth.userAgent));
  defineGetter(Navigator.prototype, 'vendor', () => String(stealth.vendor || 'Google Inc.'));
  if (Number.isFinite(Number(stealth.hardwareConcurrency))) {
    defineGetter(Navigator.prototype, 'hardwareConcurrency', () => Number(stealth.hardwareConcurrency));
  }
  if (Number.isFinite(Number(stealth.deviceMemory))) {
    defineGetter(Navigator.prototype, 'deviceMemory', () => Number(stealth.deviceMemory));
  }
  if (Number.isFinite(Number(stealth.maxTouchPoints))) {
    defineGetter(Navigator.prototype, 'maxTouchPoints', () => Number(stealth.maxTouchPoints));
  }

  const makeNamedArray = (items, nameKey = 'name') => {
    const array = items.slice();
    Object.defineProperty(array, 'item', { value: (index) => array[index] || null, configurable: true });
    Object.defineProperty(array, 'namedItem', { value: (name) => array.find((item) => item?.[nameKey] === name) || null, configurable: true });
    for (const [index, item] of array.entries()) {
      try { Object.defineProperty(array, index, { value: item, configurable: true }); } catch (_) {}
      if (item?.[nameKey]) {
        try { Object.defineProperty(array, item[nameKey], { value: item, configurable: true }); } catch (_) {}
      }
    }
    return array;
  };
  const chromePdfPlugin = {
    name: 'Chrome PDF Plugin',
    filename: 'internal-pdf-viewer',
    description: 'Portable Document Format',
  };
  const chromePdfViewerPlugin = {
    name: 'Chrome PDF Viewer',
    filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai',
    description: '',
  };
  const nativeClientPlugin = {
    name: 'Native Client',
    filename: 'internal-nacl-plugin',
    description: '',
  };
  const pdfMime = { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format', enabledPlugin: chromePdfPlugin };
  const xGooglePdfMime = { type: 'application/x-google-chrome-pdf', suffixes: 'pdf', description: 'Portable Document Format', enabledPlugin: chromePdfViewerPlugin };
  const nativeClientMime = { type: 'application/x-nacl', suffixes: '', description: 'Native Client Executable', enabledPlugin: nativeClientPlugin };
  const portableNativeClientMime = { type: 'application/x-pnacl', suffixes: '', description: 'Portable Native Client Executable', enabledPlugin: nativeClientPlugin };
  chromePdfPlugin[0] = pdfMime;
  chromePdfPlugin.length = 1;
  chromePdfViewerPlugin[0] = xGooglePdfMime;
  chromePdfViewerPlugin.length = 1;
  nativeClientPlugin[0] = nativeClientMime;
  nativeClientPlugin[1] = portableNativeClientMime;
  nativeClientPlugin.length = 2;
  const pluginArray = makeNamedArray([chromePdfPlugin, chromePdfViewerPlugin, nativeClientPlugin]);
  Object.defineProperty(pluginArray, 'refresh', { value: () => undefined, configurable: true });
  const mimeTypeArray = makeNamedArray([pdfMime, xGooglePdfMime, nativeClientMime, portableNativeClientMime], 'type');
  defineGetter(Navigator.prototype, 'plugins', () => pluginArray);
  defineGetter(Navigator.prototype, 'mimeTypes', () => mimeTypeArray);
  if ('pdfViewerEnabled' in Navigator.prototype || 'pdfViewerEnabled' in navigator) {
    defineGetter(Navigator.prototype, 'pdfViewerEnabled', () => true);
  }

  if (!globalThis.chrome) {
    try {
      Object.defineProperty(globalThis, 'chrome', {
        value: { runtime: {} },
        configurable: true,
      });
    } catch (_) {}
  } else if (!globalThis.chrome.runtime) {
    try {
      Object.defineProperty(globalThis.chrome, 'runtime', {
        value: {},
        configurable: true,
      });
    } catch (_) {}
  }
  if (globalThis.chrome) {
    if (!globalThis.chrome.app) {
      try {
        Object.defineProperty(globalThis.chrome, 'app', {
          value: {
            isInstalled: false,
            InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
            RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
            getDetails: () => null,
            getIsInstalled: () => false,
            runningState: () => 'cannot_run',
          },
          configurable: true,
        });
      } catch (_) {}
    }
    if (!globalThis.chrome.csi) {
      try {
        Object.defineProperty(globalThis.chrome, 'csi', {
          value: () => ({ startE: Date.now(), onloadT: Date.now(), pageT: Math.max(0, Math.round(performance.now())), tran: 15 }),
          configurable: true,
        });
      } catch (_) {}
    }
    if (!globalThis.chrome.loadTimes) {
      try {
        Object.defineProperty(globalThis.chrome, 'loadTimes', {
          value: () => ({
            requestTime: Date.now() / 1000,
            startLoadTime: Date.now() / 1000,
            commitLoadTime: Date.now() / 1000,
            finishDocumentLoadTime: Date.now() / 1000,
            finishLoadTime: Date.now() / 1000,
            firstPaintTime: Date.now() / 1000,
            firstPaintAfterLoadTime: 0,
            navigationType: 'Other',
            wasFetchedViaSpdy: true,
            wasNpnNegotiated: true,
            npnNegotiatedProtocol: 'h2',
            wasAlternateProtocolAvailable: false,
            connectionInfo: 'h2',
          }),
          configurable: true,
        });
      } catch (_) {}
    }
  }

  if (globalThis.outerWidth === 0 || globalThis.outerHeight === 0) {
    defineGetter(globalThis, 'outerWidth', () => (globalThis.innerWidth || 1280) + 16);
    defineGetter(globalThis, 'outerHeight', () => (globalThis.innerHeight || 720) + 88);
  }

  if (globalThis.HTMLMediaElement?.prototype?.canPlayType) {
    const originalCanPlayType = globalThis.HTMLMediaElement.prototype.canPlayType;
    globalThis.HTMLMediaElement.prototype.canPlayType = function canPlayType(type) {
      const value = String(type || '').toLowerCase();
      if (value.includes('video/mp4') && (value.includes('avc1') || value.includes('h264'))) return 'probably';
      if (value.includes('audio/mp4') || value.includes('audio/aac')) return 'probably';
      if (value.includes('application/x-mpegurl')) return 'maybe';
      return originalCanPlayType.apply(this, arguments);
    };
  }

  const originalPermissionsQuery = globalThis.navigator?.permissions?.query?.bind(globalThis.navigator.permissions);
  if (originalPermissionsQuery) {
    try {
      globalThis.navigator.permissions.query = (parameters) => {
        if (parameters?.name === 'notifications') {
          return Promise.resolve({ state: Notification.permission, onchange: null });
        }
        return originalPermissionsQuery(parameters);
      };
    } catch (_) {}
  }

  if (stealth.webglVendor || stealth.webglRenderer) {
    const patchWebgl = (prototype) => {
      if (!prototype?.getParameter) return;
      const original = prototype.getParameter;
      prototype.getParameter = function getParameter(parameter) {
        if (parameter === 37445 && stealth.webglVendor) return String(stealth.webglVendor);
        if (parameter === 37446 && stealth.webglRenderer) return String(stealth.webglRenderer);
        return original.apply(this, arguments);
      };
    };
    patchWebgl(globalThis.WebGLRenderingContext?.prototype);
    patchWebgl(globalThis.WebGL2RenderingContext?.prototype);
  }

  if (stealth.canvasNoise && globalThis.HTMLCanvasElement?.prototype?.toDataURL) {
    const noisyCanvases = new WeakSet();
    const originalToDataURL = globalThis.HTMLCanvasElement.prototype.toDataURL;
    globalThis.HTMLCanvasElement.prototype.toDataURL = function toDataURL() {
      try {
        const context = noisyCanvases.has(this) ? null : this.getContext('2d');
        if (context && this.width > 0 && this.height > 0) {
          const width = Math.min(this.width, 32);
          const height = Math.min(this.height, 32);
          const imageData = context.getImageData(0, 0, width, height);
          for (let index = 0; index < imageData.data.length; index += 4) {
            imageData.data[index] = Math.max(0, Math.min(255, imageData.data[index] + ((Math.random() - 0.5) * 2)));
            imageData.data[index + 1] = Math.max(0, Math.min(255, imageData.data[index + 1] + ((Math.random() - 0.5) * 2)));
            imageData.data[index + 2] = Math.max(0, Math.min(255, imageData.data[index + 2] + ((Math.random() - 0.5) * 2)));
          }
          context.putImageData(imageData, 0, 0);
          noisyCanvases.add(this);
        }
      } catch (_) {}
      return originalToDataURL.apply(this, arguments);
    };
  }

  if (stealth.audioNoise && globalThis.AudioBuffer?.prototype?.getChannelData) {
    const originalGetChannelData = globalThis.AudioBuffer.prototype.getChannelData;
    globalThis.AudioBuffer.prototype.getChannelData = function getChannelData(channel) {
      const data = originalGetChannelData.call(this, channel);
      try {
        if (!this.__BRS_AUDIO_NOISE__) {
          this.__BRS_AUDIO_NOISE__ = new Map();
        }
        if (!this.__BRS_AUDIO_NOISE__.has(channel)) {
          const copy = new Float32Array(data);
          for (let index = 0; index < copy.length; index += 100) {
            copy[index] += (Math.random() - 0.5) * 0.00001;
          }
          this.__BRS_AUDIO_NOISE__.set(channel, copy);
        }
        return this.__BRS_AUDIO_NOISE__.get(channel);
      } catch (_) {
        return data;
      }
    };
  }

  try {
    Object.defineProperty(globalThis, '__BRS_STEALTH__', {
      value: {
        profile: stealth.profile || 'standard',
        enabled: true,
        evasions: ['webdriver', 'ua', 'ua-ch', 'languages', 'plugins', 'mimeTypes', 'vendor', 'chrome-runtime', 'permissions', 'webgl', 'canvas', 'audio', 'media-codecs'],
        at: new Date().toISOString(),
      },
      configurable: true,
    });
  } catch (_) {}
})();
