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
if [ -n "${BROWSER_PROXY_SERVER:-}" ]; then
  echo "Using browser proxy: ${BROWSER_PROXY_SERVER}"
  CHROME_PROXY_ARGS+=("--proxy-server=${BROWSER_PROXY_SERVER}")
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
  if [ -n "${BROWSER_RUNTIME_BROKER_WS:-}" ]; then
    python3 - "${BROWSER_RUNTIME_BROKER_WS}" "${GENERATED_EXTENSION_DIR}/runtime-config.js" <<'PY'
import json
import pathlib
import sys

broker_ws, output = sys.argv[1], pathlib.Path(sys.argv[2])
output.write_text(f"globalThis.BRS_CONFIG = {{ brokerWs: {json.dumps(broker_ws)} }};\n", encoding="utf-8")
PY
  fi
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
