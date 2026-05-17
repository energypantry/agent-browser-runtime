#!/bin/bash
set -euo pipefail

# Wait for Xvfb to be ready.
sleep 2

export DISPLAY=:${DISPLAY_NUM:-99}
USER_DATA_DIR="/data/user-data"
RUNTIME_SIGNATURE_FILE="${USER_DATA_DIR}/.runtime-signature"
mkdir -p "${USER_DATA_DIR}"

is_enabled() {
  case "${1:-}" in
    1|true|TRUE|yes|YES|on|ON) return 0 ;;
    *) return 1 ;;
  esac
}

CURRENT_RUNTIME_SIGNATURE="${BOT_RUNTIME_SIGNATURE:-}"
if [ -n "${CURRENT_RUNTIME_SIGNATURE}" ]; then
  PREVIOUS_RUNTIME_SIGNATURE=""
  if [ -f "${RUNTIME_SIGNATURE_FILE}" ]; then
    PREVIOUS_RUNTIME_SIGNATURE="$(cat "${RUNTIME_SIGNATURE_FILE}" 2>/dev/null || true)"
  fi

  if [ -n "${PREVIOUS_RUNTIME_SIGNATURE}" ] && [ "${PREVIOUS_RUNTIME_SIGNATURE}" != "${CURRENT_RUNTIME_SIGNATURE}" ]; then
    echo "Runtime signature changed"
    echo "  previous: ${PREVIOUS_RUNTIME_SIGNATURE}"
    echo "  current:  ${CURRENT_RUNTIME_SIGNATURE}"
    if is_enabled "${BRS_RESET_PROFILE_ON_SIGNATURE_CHANGE:-0}"; then
      echo "Resetting persisted browser profile because BRS_RESET_PROFILE_ON_SIGNATURE_CHANGE=1"
      # Keep the artifacts mount in place; it may be a Docker bind mount and cannot be moved.
      find "${USER_DATA_DIR}" -mindepth 1 -maxdepth 1 ! -name artifacts -exec rm -rf {} +
    else
      echo "Preserving persisted browser profile; set BRS_RESET_PROFILE_ON_SIGNATURE_CHANGE=1 to reset explicitly"
    fi
  fi

  printf '%s' "${CURRENT_RUNTIME_SIGNATURE}" > "${RUNTIME_SIGNATURE_FILE}"
fi

rm -f "${USER_DATA_DIR}"/SingletonLock \
      "${USER_DATA_DIR}"/SingletonCookie \
      "${USER_DATA_DIR}"/SingletonSocket \
      "${USER_DATA_DIR}"/SingletonSocket.lock \
      "${USER_DATA_DIR}"/DevToolsActivePort

CHROME_PROXY_ARGS=()
EFFECTIVE_PROXY_SERVER="${BROWSER_PROXY_SERVER:-}"
if [ -z "${EFFECTIVE_PROXY_SERVER}" ] && is_enabled "${BRS_TLS_GATEWAY_ENABLED:-1}" && [ -n "${BRS_TLS_GATEWAY_PROXY_SERVER:-}" ]; then
  EFFECTIVE_PROXY_SERVER="${BRS_TLS_GATEWAY_PROXY_SERVER}"
  echo "Using TLS gateway proxy: ${BRS_TLS_GATEWAY_PROXY_SERVER}"
elif [ -n "${EFFECTIVE_PROXY_SERVER}" ]; then
  echo "Using browser proxy: ${EFFECTIVE_PROXY_SERVER}"
fi
if [ -n "${EFFECTIVE_PROXY_SERVER}" ]; then
  CHROME_PROXY_ARGS+=("--proxy-server=${EFFECTIVE_PROXY_SERVER}")
  CHROME_PROXY_ARGS+=("--disable-quic")
fi
if [ -n "${BROWSER_PROXY_BYPASS_LIST:-}" ]; then
  echo "Using proxy bypass list: ${BROWSER_PROXY_BYPASS_LIST}"
  CHROME_PROXY_ARGS+=("--proxy-bypass-list=${BROWSER_PROXY_BYPASS_LIST}")
fi

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
  export BRS_BROWSER_BINARY_KIND="fingerprint-chromium"
  export BRS_FINGERPRINT_CHROMIUM_ACTIVE="1"
  export BRS_FINGERPRINT_CHROMIUM_BINARY="${FINGERPRINT_BIN}"
else
  export BRS_BROWSER_BINARY_KIND="system-chromium"
  export BRS_FINGERPRINT_CHROMIUM_ACTIVE="0"
  export BRS_FINGERPRINT_CHROMIUM_BINARY=""
fi
export BRS_RUNTIME_CONFIG_GENERATOR_VERSION="v3-chrome124-macos-preset"

DETECTED_CHROME_FULL_VERSION=""
DETECTED_CHROME_MAJOR=""
CHROME_VERSION_BIN=""
if [ -n "${FINGERPRINT_BIN}" ]; then
  CHROME_VERSION_BIN="${FINGERPRINT_BIN}"
elif command -v chromium >/dev/null 2>&1; then
  CHROME_VERSION_BIN="chromium"
fi
if [ -n "${CHROME_VERSION_BIN}" ]; then
  CHROME_VERSION_TEXT="$("${CHROME_VERSION_BIN}" --version 2>/dev/null || true)"
  if [[ "${CHROME_VERSION_TEXT}" =~ ([0-9]+)\.([0-9]+)\.([0-9]+)\.([0-9]+) ]]; then
    DETECTED_CHROME_FULL_VERSION="${BASH_REMATCH[0]}"
    DETECTED_CHROME_MAJOR="${BASH_REMATCH[1]}"
    export BRS_DETECTED_CHROME_FULL_VERSION="${DETECTED_CHROME_FULL_VERSION}"
    export BRS_DETECTED_CHROME_MAJOR="${DETECTED_CHROME_MAJOR}"
    echo "Detected browser version: ${DETECTED_CHROME_FULL_VERSION} (${BRS_BROWSER_BINARY_KIND})"
  fi
fi

EXTENSION_ARGS=()
if [ -n "${BROWSER_EXTENSION_DIR:-}" ] && [ -f "${BROWSER_EXTENSION_DIR}/manifest.json" ]; then
  EXTENSION_BASE_ID="$(printf '%s' "${BOT_RUNTIME_SIGNATURE:-default}" | tr -c 'A-Za-z0-9_.-' '_' | cut -c1-56)"
  EXTENSION_CONFIG_HASH="$(python3 - <<'PY'
import hashlib
import os

exact = {
    "BOT_RUNTIME_SIGNATURE",
    "BROWSER_PROXY_BYPASS_LIST",
    "BROWSER_PROXY_SERVER",
    "BROWSER_RUNTIME_BROKER_WS",
    "BROWSER_TIMEZONE",
}
items = []
for key in sorted(os.environ):
    if key.startswith("BRS_") or key.startswith("FINGERPRINT_") or key in exact:
        items.append(f"{key}={os.environ.get(key, '')}")
extension_dir = os.environ.get("BROWSER_EXTENSION_DIR", "")
if extension_dir and os.path.isdir(extension_dir):
    for root, _, files in os.walk(extension_dir):
        for name in sorted(files):
            path = os.path.join(root, name)
            rel = os.path.relpath(path, extension_dir)
            try:
                with open(path, "rb") as handle:
                    digest = hashlib.sha256(handle.read()).hexdigest()
            except OSError:
                continue
            items.append(f"extension:{rel}={digest}")
print(hashlib.sha256("\n".join(items).encode("utf-8")).hexdigest()[:12])
PY
)"
  EXTENSION_INSTANCE_ID="${EXTENSION_BASE_ID}-${EXTENSION_CONFIG_HASH}"
  GENERATED_EXTENSION_DIR="/tmp/browser-runtime-extension-${EXTENSION_INSTANCE_ID}"
  rm -rf "${GENERATED_EXTENSION_DIR}"
  mkdir -p "${GENERATED_EXTENSION_DIR}"
  cp -a "${BROWSER_EXTENSION_DIR}/." "${GENERATED_EXTENSION_DIR}/"
  python3 - "${GENERATED_EXTENSION_DIR}/runtime-config.js" <<'PY'
import hashlib
import json
import os
import pathlib
import random
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

def csv_list(name, fallback):
    raw = env(name, "")
    if not raw:
        return fallback
    return [part.strip() for part in raw.split(",") if part.strip()]

def seed_int():
    raw = env("BRS_FINGERPRINT_SEED", env("FINGERPRINT_SEED", "1000"))
    try:
        return int(raw), raw
    except ValueError:
        digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()
        return int(digest[:8], 16), raw

def merge_headers(base, overrides):
    result = dict(base)
    index = {key.lower(): key for key in result}
    for key, value in overrides.items():
        if value is None or value == "":
            continue
        existing = index.get(str(key).lower())
        if existing:
            result[existing] = str(value)
        else:
            result[str(key)] = str(value)
    return result

def languages_from_accept_language(value):
    return [
        part.split(";")[0].strip()
        for part in value.split(",")
        if part.split(";")[0].strip()
    ]

def chrome_version(rng, major):
    stable_builds = {
        122: [6261, 6262],
        123: [6312],
        124: [6367],
        125: [6422],
        126: [6478],
        127: [6533],
        128: [6613],
        129: [6668],
        130: [6723],
    }
    build = rng.choice(stable_builds.get(major, [6723, 6778, 6834]))
    patch = rng.choice([69, 79, 85, 91, 99, 113, 128, 141])
    return f"{major}.0.{build}.{patch}"

def platform_profile(platform_key, rng):
    profiles = {
        "macos": {
            "uaPlatform": "Macintosh; Intel Mac OS X 10_15_7",
            "navigatorPlatform": "MacIntel",
            "uaChPlatform": "macOS",
            "platformVersion": rng.choice(["13.6.7", "14.6.1", "15.0.0"]),
            "architecture": "arm",
            "bitness": "64",
            "webglVendor": "Google Inc. (Apple)",
            "webglRenderers": [
                "ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Pro, Unspecified Version)",
                "ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)",
                "ANGLE (Apple, ANGLE Metal Renderer: Apple M3, Unspecified Version)",
            ],
            "hardwareConcurrency": rng.choice([8, 10, 12]),
            "deviceMemory": rng.choice([8, 16]),
            "maxTouchPoints": 0,
        },
        "windows": {
            "uaPlatform": "Windows NT 10.0; Win64; x64",
            "navigatorPlatform": "Win32",
            "uaChPlatform": "Windows",
            "platformVersion": "10.0.0",
            "architecture": "x86",
            "bitness": "64",
            "webglVendor": "Google Inc. (NVIDIA)",
            "webglRenderers": [
                "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)",
                "ANGLE (Intel, Intel(R) UHD Graphics 770 Direct3D11 vs_5_0 ps_5_0, D3D11)",
                "ANGLE (AMD, AMD Radeon RX 6600 Direct3D11 vs_5_0 ps_5_0, D3D11)",
            ],
            "hardwareConcurrency": rng.choice([8, 12, 16]),
            "deviceMemory": rng.choice([8, 16]),
            "maxTouchPoints": 0,
        },
        "linux": {
            "uaPlatform": "X11; Linux x86_64",
            "navigatorPlatform": "Linux x86_64",
            "uaChPlatform": "Linux",
            "platformVersion": "6.5.0",
            "architecture": "x86",
            "bitness": "64",
            "webglVendor": "Google Inc. (Intel)",
            "webglRenderers": [
                "ANGLE (Intel, Mesa Intel(R) UHD Graphics, OpenGL 4.6)",
                "ANGLE (AMD, AMD Radeon Graphics, OpenGL 4.6)",
            ],
            "hardwareConcurrency": rng.choice([8, 12, 16]),
            "deviceMemory": rng.choice([8, 16]),
            "maxTouchPoints": 0,
        },
    }
    return profiles.get(platform_key, profiles["windows"])

def build_fingerprint():
    enabled = flag("BRS_GENERATE_FINGERPRINT_ENABLED", True)
    seed, raw_seed = seed_int()
    rng = random.Random(seed)
    platform_key = env("BRS_FINGERPRINT_PLATFORM", env("FINGERPRINT_PLATFORM", "windows")).lower()
    platform = platform_profile(platform_key, rng)
    explicit_major = env("BRS_CHROME_MAJOR", "")
    detected_major = env("BRS_DETECTED_CHROME_MAJOR", "")
    major = int(explicit_major or detected_major or "124")
    explicit_full_version = env("BRS_CHROME_FULL_VERSION", "")
    detected_full_version = env("BRS_DETECTED_CHROME_FULL_VERSION", "")
    if explicit_full_version:
        full_version = explicit_full_version
    elif explicit_major:
        full_version = chrome_version(rng, major)
    else:
        full_version = detected_full_version or chrome_version(rng, major)
    browser_brand = env("BRS_BROWSER_BRAND", "Google Chrome")
    not_brand_version = str(rng.choice([8, 24, 99]))
    brands = [
        {"brand": "Not.A/Brand", "version": not_brand_version},
        {"brand": "Chromium", "version": str(major)},
        {"brand": browser_brand, "version": str(major)},
    ]
    rng.shuffle(brands)
    full_version_list = [
        {"brand": item["brand"], "version": full_version if item["brand"] != "Not.A/Brand" else f"{not_brand_version}.0.0.0"}
        for item in brands
    ]
    accept_language = env("BRS_ACCEPT_LANGUAGE", "en-US,en;q=0.9")
    languages = json_list("BRS_LANGUAGES_JSON", languages_from_accept_language(accept_language) or ["en-US", "en"])
    user_agent = (
        f"Mozilla/5.0 ({platform['uaPlatform']}) AppleWebKit/537.36 "
        f"(KHTML, like Gecko) Chrome/{full_version} Safari/537.36"
    )
    metadata = {
        "brands": brands,
        "fullVersion": full_version,
        "fullVersionList": full_version_list,
        "platform": platform["uaChPlatform"],
        "platformVersion": platform["platformVersion"],
        "architecture": platform["architecture"],
        "model": "",
        "mobile": False,
        "bitness": platform["bitness"],
        "wow64": False,
    }
    sec_ch_ua = ", ".join([f'"{item["brand"]}";v="{item["version"]}"' for item in brands])
    sec_ch_full = ", ".join([f'"{item["brand"]}";v="{item["version"]}"' for item in full_version_list])
    generated_headers = {
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        "Accept-Language": accept_language,
        "Upgrade-Insecure-Requests": "1",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-User": "?1",
        "Sec-Fetch-Dest": "document",
        "sec-ch-ua": sec_ch_ua,
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": f'"{platform["uaChPlatform"]}"',
        "sec-ch-ua-platform-version": f'"{platform["platformVersion"]}"',
        "sec-ch-ua-arch": f'"{platform["architecture"]}"',
        "sec-ch-ua-bitness": f'"{platform["bitness"]}"',
        "sec-ch-ua-model": '""',
        "sec-ch-ua-full-version": f'"{full_version}"',
        "sec-ch-ua-full-version-list": sec_ch_full,
    }
    return {
        "enabled": enabled,
        "seed": raw_seed,
        "platformKey": platform_key,
        "chromeMajor": major,
        "chromeFullVersion": full_version,
        "browserBrand": browser_brand,
        "acceptLanguage": accept_language,
        "languages": languages,
        "navigatorPlatform": platform["navigatorPlatform"],
        "userAgent": user_agent,
        "userAgentMetadata": metadata,
        "webglVendor": platform["webglVendor"],
        "webglRenderer": rng.choice(platform["webglRenderers"]),
        "hardwareConcurrency": platform["hardwareConcurrency"],
        "deviceMemory": platform["deviceMemory"],
        "maxTouchPoints": platform["maxTouchPoints"],
        "headers": generated_headers,
    }

fingerprint = build_fingerprint()
accept_language = env("BRS_ACCEPT_LANGUAGE", fingerprint["acceptLanguage"])
derived_languages = languages_from_accept_language(accept_language)
explicit_headers = json_object("BRS_EXTRA_HTTP_HEADERS_JSON")
generated_headers = fingerprint["headers"] if fingerprint["enabled"] else {}
extra_headers = merge_headers(generated_headers, explicit_headers)
tls_proxy_server = env("BRS_TLS_GATEWAY_PROXY_SERVER", "")
tls_enabled = flag("BRS_TLS_GATEWAY_ENABLED", True)
browser_proxy_server = env("BROWSER_PROXY_SERVER", "")
explicit_user_agent = env("BRS_USER_AGENT", "")
explicit_platform = env("BRS_PLATFORM", "")
config = {
    "brokerWs": env("BROWSER_RUNTIME_BROKER_WS", "ws://broker:17890/extension"),
    "browserRuntime": {
        "preset": env("BRS_RUNTIME_PRESET", ""),
        "binary": env("BRS_BROWSER_BINARY_KIND", "system-chromium"),
        "fingerprintChromium": {
            "active": flag("BRS_FINGERPRINT_CHROMIUM_ACTIVE", False),
            "binary": env("BRS_FINGERPRINT_CHROMIUM_BINARY", ""),
            "mountPath": "/opt/fingerprint-chromium",
            "fingerprintSeed": env("FINGERPRINT_SEED", "1000"),
            "fingerprintPlatform": env("FINGERPRINT_PLATFORM", "windows"),
        },
    },
    "fingerprint": {
        "generated": fingerprint["enabled"],
        "seed": fingerprint["seed"],
        "platformKey": fingerprint["platformKey"],
        "chromeMajor": fingerprint["chromeMajor"],
        "chromeFullVersion": fingerprint["chromeFullVersion"],
        "browserBrand": fingerprint["browserBrand"],
        "headerKeys": sorted(extra_headers.keys()),
    },
    "stealth": {
        "enabled": flag("BRS_STEALTH_ENABLED", True),
        "profile": env("BRS_STEALTH_PROFILE", "standard"),
        "excludedHosts": csv_list("BRS_STEALTH_EXCLUDED_HOSTS", ["accounts.google.com"]),
        "headersEnabled": flag("BRS_FINGERPRINT_HEADERS_ENABLED", True),
        "patchesEnabled": flag("BRS_FINGERPRINT_PATCHES_ENABLED", True),
        "canvasNoise": flag("BRS_CANVAS_NOISE_ENABLED", True),
        "audioNoise": flag("BRS_AUDIO_NOISE_ENABLED", True),
        "acceptLanguage": accept_language,
        "languages": json_list("BRS_LANGUAGES_JSON", fingerprint["languages"] or derived_languages or ["en-US", "en"]),
        "locale": env("BRS_LOCALE", "en-US"),
        "timezone": env("BRS_STEALTH_TIMEZONE", env("BROWSER_TIMEZONE", "UTC")),
        "platform": explicit_platform or (fingerprint["navigatorPlatform"] if fingerprint["enabled"] else ""),
        "userAgent": explicit_user_agent or (fingerprint["userAgent"] if fingerprint["enabled"] else ""),
        "userAgentMetadata": fingerprint["userAgentMetadata"] if fingerprint["enabled"] and not explicit_user_agent else None,
        "webglVendor": env("BRS_WEBGL_VENDOR", fingerprint["webglVendor"] if fingerprint["enabled"] else ""),
        "webglRenderer": env("BRS_WEBGL_RENDERER", fingerprint["webglRenderer"] if fingerprint["enabled"] else ""),
        "hardwareConcurrency": fingerprint["hardwareConcurrency"] if fingerprint["enabled"] else None,
        "deviceMemory": fingerprint["deviceMemory"] if fingerprint["enabled"] else None,
        "maxTouchPoints": fingerprint["maxTouchPoints"] if fingerprint["enabled"] else None,
        "extraHeaders": extra_headers,
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
  --timezone="${BROWSER_TIMEZONE:-UTC}"
  --user-data-dir="${USER_DATA_DIR}"
  --remote-debugging-port="${CDP_PORT:-9222}"
  --remote-debugging-address=0.0.0.0
  --window-size="${SCREEN_WIDTH:-1440},${SCREEN_HEIGHT:-1000}"
  --start-maximized
)

if [ -n "${FINGERPRINT_BIN}" ]; then
  echo "Using fingerprint-chromium binary: ${FINGERPRINT_BIN} (seed=${FINGERPRINT_SEED:-1000})"
  exec "${FINGERPRINT_BIN}" \
    "${COMMON_ARGS[@]}" \
    --fingerprint="${FINGERPRINT_SEED:-1000}" \
    --fingerprint-platform="${FINGERPRINT_PLATFORM:-windows}" \
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
