#!/bin/bash
set -euo pipefail

# Wait for Xvfb to be ready.
sleep 2

export DISPLAY=:${DISPLAY_NUM:-99}
USER_DATA_DIR="/data/user-data"
RUNTIME_SIGNATURE_FILE="${USER_DATA_DIR}/.runtime-signature"
mkdir -p "${USER_DATA_DIR}"

CURRENT_RUNTIME_SIGNATURE="${BOT_RUNTIME_SIGNATURE:-}"
if [ -n "${CURRENT_RUNTIME_SIGNATURE}" ]; then
  PREVIOUS_RUNTIME_SIGNATURE=""
  if [ -f "${RUNTIME_SIGNATURE_FILE}" ]; then
    PREVIOUS_RUNTIME_SIGNATURE="$(cat "${RUNTIME_SIGNATURE_FILE}" 2>/dev/null || true)"
  fi

  if [ -n "${PREVIOUS_RUNTIME_SIGNATURE}" ] && [ "${PREVIOUS_RUNTIME_SIGNATURE}" != "${CURRENT_RUNTIME_SIGNATURE}" ]; then
    echo "Runtime signature changed, resetting persisted browser profile"
    echo "  previous: ${PREVIOUS_RUNTIME_SIGNATURE}"
    echo "  current:  ${CURRENT_RUNTIME_SIGNATURE}"

    # Keep the artifacts mount in place; it may be a Docker bind mount and cannot be moved.
    find "${USER_DATA_DIR}" -mindepth 1 -maxdepth 1 ! -name artifacts -exec rm -rf {} +
  fi

  printf '%s' "${CURRENT_RUNTIME_SIGNATURE}" > "${RUNTIME_SIGNATURE_FILE}"
fi

rm -f "${USER_DATA_DIR}"/SingletonLock \
      "${USER_DATA_DIR}"/SingletonCookie \
      "${USER_DATA_DIR}"/SingletonSocket \
      "${USER_DATA_DIR}"/SingletonSocket.lock \
      "${USER_DATA_DIR}"/DevToolsActivePort

CHROME_PROXY_ARGS=()
is_enabled() {
  case "${1:-}" in
    1|true|TRUE|yes|YES|on|ON) return 0 ;;
    *) return 1 ;;
  esac
}

EFFECTIVE_PROXY_SERVER="${BROWSER_PROXY_SERVER:-}"
if [ -z "${EFFECTIVE_PROXY_SERVER}" ] && is_enabled "${BRS_TLS_GATEWAY_ENABLED:-1}" && [ -n "${BRS_TLS_GATEWAY_PROXY_SERVER:-}" ]; then
  EFFECTIVE_PROXY_SERVER="${BRS_TLS_GATEWAY_PROXY_SERVER}"
  echo "Using TLS gateway proxy: ${BRS_TLS_GATEWAY_PROXY_SERVER}"
elif [ -n "${EFFECTIVE_PROXY_SERVER}" ]; then
  echo "Using browser proxy: ${EFFECTIVE_PROXY_SERVER}"
fi
if [ -n "${EFFECTIVE_PROXY_SERVER}" ]; then
  CHROME_PROXY_ARGS+=("--proxy-server=${EFFECTIVE_PROXY_SERVER}")
fi
if [ -n "${BROWSER_PROXY_BYPASS_LIST:-}" ]; then
  echo "Using proxy bypass list: ${BROWSER_PROXY_BYPASS_LIST}"
  CHROME_PROXY_ARGS+=("--proxy-bypass-list=${BROWSER_PROXY_BYPASS_LIST}")
fi

EXTENSION_ARGS=()
if [ -n "${BROWSER_EXTENSION_DIR:-}" ] && [ -f "${BROWSER_EXTENSION_DIR}/manifest.json" ]; then
  GENERATED_EXTENSION_DIR="/tmp/browser-runtime-extension"
  rm -rf "${GENERATED_EXTENSION_DIR}"
  mkdir -p "${GENERATED_EXTENSION_DIR}"
  cp -a "${BROWSER_EXTENSION_DIR}/." "${GENERATED_EXTENSION_DIR}/"
  python3 - "${GENERATED_EXTENSION_DIR}/runtime-config.js" <<'PY'
import json
import os
import pathlib
import sys

output = pathlib.Path(sys.argv[1])

def env(name, default=""):
    value = os.environ.get(name)
    return default if value is None or value == "" else value

def flag(name, default=True):
    value = os.environ.get(name)
    if value is None or value == "":
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}

def json_object(name):
    raw = os.environ.get(name, "").strip()
    if not raw:
        return {}
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as error:
        print(f"Ignoring invalid {name}: {error}", file=sys.stderr)
        return {}
    return value if isinstance(value, dict) else {}

def json_list(name, fallback):
    raw = os.environ.get(name, "").strip()
    if raw:
        try:
            value = json.loads(raw)
            if isinstance(value, list):
                return [str(item) for item in value if str(item)]
        except json.JSONDecodeError as error:
            print(f"Ignoring invalid {name}: {error}", file=sys.stderr)
    return fallback

accept_language = env("BRS_ACCEPT_LANGUAGE", "en-US,en;q=0.9")
derived_languages = [
    part.split(";")[0].strip()
    for part in accept_language.split(",")
    if part.split(";")[0].strip()
]
tls_proxy_server = env("BRS_TLS_GATEWAY_PROXY_SERVER", "")
tls_enabled = flag("BRS_TLS_GATEWAY_ENABLED", True)
browser_proxy_server = env("BROWSER_PROXY_SERVER", "")
config = {
    "brokerWs": env("BROWSER_RUNTIME_BROKER_WS", "ws://broker:17890/extension"),
    "stealth": {
        "enabled": flag("BRS_STEALTH_ENABLED", True),
        "profile": env("BRS_STEALTH_PROFILE", "standard"),
        "headersEnabled": flag("BRS_FINGERPRINT_HEADERS_ENABLED", True),
        "patchesEnabled": flag("BRS_FINGERPRINT_PATCHES_ENABLED", True),
        "canvasNoise": flag("BRS_CANVAS_NOISE_ENABLED", True),
        "audioNoise": flag("BRS_AUDIO_NOISE_ENABLED", True),
        "acceptLanguage": accept_language,
        "languages": json_list("BRS_LANGUAGES_JSON", derived_languages or ["en-US", "en"]),
        "locale": env("BRS_LOCALE", "en-US"),
        "timezone": env("BRS_STEALTH_TIMEZONE", env("BROWSER_TIMEZONE", "Asia/Shanghai")),
        "platform": env("BRS_PLATFORM", ""),
        "userAgent": env("BRS_USER_AGENT", ""),
        "webglVendor": env("BRS_WEBGL_VENDOR", ""),
        "webglRenderer": env("BRS_WEBGL_RENDERER", ""),
        "extraHeaders": json_object("BRS_EXTRA_HTTP_HEADERS_JSON"),
        "tlsGateway": {
            "enabled": tls_enabled,
            "proxyServer": tls_proxy_server,
            "active": bool(tls_enabled and tls_proxy_server and not browser_proxy_server),
        },
    },
}
output.write_text(f"globalThis.BRS_CONFIG = {json.dumps(config, indent=2, sort_keys=True)};\n", encoding="utf-8")
PY
  EXTENSION_ARGS+=("--disable-extensions-except=${GENERATED_EXTENSION_DIR}" "--load-extension=${GENERATED_EXTENSION_DIR}")
fi

COMMON_ARGS=(
  --no-first-run
  --no-sandbox
  --disable-default-apps
  --disable-sync
  --no-default-browser-check
  --disable-blink-features=AutomationControlled
  --timezone="${BROWSER_TIMEZONE:-Asia/Shanghai}"
  --user-data-dir="${USER_DATA_DIR}"
  --remote-debugging-port="${CDP_PORT:-9222}"
  --remote-debugging-address=0.0.0.0
  --window-size="${SCREEN_WIDTH:-1440},${SCREEN_HEIGHT:-1000}"
  --start-maximized
)

FINGERPRINT_BIN=""
if [ -x "/opt/fingerprint-chromium/chrome-wrapper" ]; then
  FINGERPRINT_BIN="/opt/fingerprint-chromium/chrome-wrapper"
elif [ -x "/opt/fingerprint-chromium/chrome" ]; then
  FINGERPRINT_BIN="/opt/fingerprint-chromium/chrome"
else
  NESTED_FINGERPRINT_BIN="$(find /opt/fingerprint-chromium -maxdepth 2 -type f \( -name chrome-wrapper -o -name chrome \) 2>/dev/null | head -n 1)"
  if [ -n "${NESTED_FINGERPRINT_BIN}" ] && [ -x "${NESTED_FINGERPRINT_BIN}" ]; then
    FINGERPRINT_BIN="${NESTED_FINGERPRINT_BIN}"
  fi
fi

if [ -n "${FINGERPRINT_BIN}" ]; then
  echo "Using fingerprint-chromium binary: ${FINGERPRINT_BIN} (seed=${FINGERPRINT_SEED:-1000})"
  exec "${FINGERPRINT_BIN}" \
    "${COMMON_ARGS[@]}" \
    --fingerprint="${FINGERPRINT_SEED:-1000}" \
    --fingerprint-platform="${FINGERPRINT_PLATFORM:-macos}" \
    "${EXTENSION_ARGS[@]}" \
    "${CHROME_PROXY_ARGS[@]}" \
    about:blank
else
  echo "Using system Chromium (no fingerprint-chromium binary mounted)"
  exec chromium \
    "${COMMON_ARGS[@]}" \
    --disable-gpu \
    "${EXTENSION_ARGS[@]}" \
    "${CHROME_PROXY_ARGS[@]}" \
    about:blank
fi
