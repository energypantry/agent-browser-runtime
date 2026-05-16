(() => {
  const config = globalThis.BRS_CONFIG || {};
  const stealth = config.stealth || {};
  if (!stealth.enabled || !stealth.patchesEnabled) return;

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
    const originalToDataURL = globalThis.HTMLCanvasElement.prototype.toDataURL;
    globalThis.HTMLCanvasElement.prototype.toDataURL = function toDataURL() {
      try {
        const context = this.getContext('2d');
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
        at: new Date().toISOString(),
      },
      configurable: true,
    });
  } catch (_) {}
})();
