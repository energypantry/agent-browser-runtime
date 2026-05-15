#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

AGENT_ID="${BRS_SMOKE_AGENT:-vovo}"
TASK_PREFIX="${BRS_SMOKE_TASK_PREFIX:-smoke-$(date +%Y%m%d-%H%M%S)}"
TARGET_URL="${BRS_SMOKE_URL:-https://example.com}"
HUMANIZE_LEVEL="${BRS_SMOKE_HUMANIZE:-enhanced}"
KEEP_STACK="${BRS_SMOKE_KEEP_STACK:-1}"

log() { printf '\n[smoke] %s\n' "$*" >&2; }
fail() { printf '\n[smoke][FAIL] %s\n' "$*" >&2; exit 1; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

json_field() {
  python3 - "$1" "$2" <<'PY'
import json, sys
path, expr = sys.argv[1], sys.argv[2]
with open(path) as f:
    data = json.load(f)
cur = data
for part in expr.split('.'):
    if part == '':
        continue
    if part.isdigit():
        cur = cur[int(part)]
    else:
        cur = cur[part]
print(cur)
PY
}

validate_artifacts() {
  local json_file="$1"
  python3 - "$json_file" "$ROOT_DIR" <<'PY'
import json, pathlib, sys
payload_path, root = sys.argv[1], pathlib.Path(sys.argv[2])
with open(payload_path) as f:
    payload = json.load(f)
lease = payload.get('lease') or {}
if lease.get('status') != 'released':
    raise SystemExit(f"lease not released: {lease}")
artifacts = payload.get('artifacts') or []
if not artifacts:
    raise SystemExit('no artifacts returned')
for artifact in artifacts:
    returned = artifact.get('path') or ''
    if not returned.startswith('/artifacts/'):
        raise SystemExit(f"unexpected artifact path: {returned}")
    local = root / 'artifacts' / returned.replace('/artifacts/', '', 1)
    if not local.exists():
        raise SystemExit(f"artifact missing: {local}")
    size = local.stat().st_size
    if size <= 0:
        raise SystemExit(f"artifact empty: {local}")
    if artifact.get('bytes') is not None and size != artifact['bytes']:
        raise SystemExit(f"artifact byte mismatch: {local}: {size} != {artifact['bytes']}")
    print(f"verified {artifact.get('kind')} {local} {size} bytes")
PY
}

cleanup_lease() {
  local lease_id="${1:-}"
  if [[ -n "${lease_id}" ]]; then
    ./cli/brs.js release "${lease_id}" >/dev/null 2>&1 || true
  fi
}

require_cmd docker
require_cmd node
require_cmd python3

FETCH_JSON="/tmp/brs-smoke-fetch-${TASK_PREFIX}.json"
EXTRACT_JSON="/tmp/brs-smoke-extract-${TASK_PREFIX}.json"
ERROR_EXTRACT_STDOUT="/tmp/brs-smoke-error-extract-${TASK_PREFIX}.out"
ERROR_EXTRACT_STDERR="/tmp/brs-smoke-error-extract-${TASK_PREFIX}.err"
DOWNLOAD_JSON="/tmp/brs-smoke-download-${TASK_PREFIX}.json"
LEASE_JSON="/tmp/brs-smoke-lease-${TASK_PREFIX}.json"
OPEN_JSON="/tmp/brs-smoke-open-${TASK_PREFIX}.json"
STATUS_JSON="/tmp/brs-smoke-status-${TASK_PREFIX}.json"
LEASE_ID=""
trap 'cleanup_lease "${LEASE_ID}"' EXIT

log "syntax check"
node --check broker/src/server.js >/dev/null
node --check broker/src/extension-rpc.js >/dev/null
node --check broker/src/store.js >/dev/null
node --check extension/background.js >/dev/null
node --check cli/brs.js >/dev/null
node --check extractors/example.extract.js >/dev/null
node --check extractors/failing.extract.js >/dev/null

log "compose config"
docker compose config >/tmp/browser-runtime-skill-compose-config.txt

log "compose up --build -d"
docker compose up --build -d >/tmp/browser-runtime-skill-smoke-up.log

log "waiting for broker/extension"
for _ in $(seq 1 30); do
  if ./cli/brs.js status >"${STATUS_JSON}" 2>/dev/null; then
    if python3 - "$STATUS_JSON" <<'PY'
import json, sys
with open(sys.argv[1]) as f:
    status = json.load(f)
raise SystemExit(0 if status.get('extensionConnected') is True else 1)
PY
    then
      break
    fi
  fi
  sleep 2
done
python3 - "$STATUS_JSON" <<'PY'
import json, sys
with open(sys.argv[1]) as f:
    status = json.load(f)
if status.get('extensionConnected') is not True:
    raise SystemExit(f"extension not connected: {status}")
print('extensionConnected=true')
print('humanize=', status.get('humanize'))
print('activeLeases=', len(status.get('leases') or []))
PY

log "one-shot fetch with humanize=${HUMANIZE_LEVEL}"
./cli/brs.js fetch "${TARGET_URL}" \
  --agent "${AGENT_ID}" \
  --task "${TASK_PREFIX}-fetch" \
  --screenshot \
  --humanize "${HUMANIZE_LEVEL}" >"${FETCH_JSON}"
validate_artifacts "${FETCH_JSON}"

log "extractor smoke"
./cli/brs.js extract example.extract.js "${TARGET_URL}" \
  --agent "${AGENT_ID}" \
  --task "${TASK_PREFIX}-extract" \
  --screenshot \
  --save-html \
  --humanize "${HUMANIZE_LEVEL}" \
  --params '{"includeLength":true}' \
  --max-attempts 2 >"${EXTRACT_JSON}"
validate_artifacts "${EXTRACT_JSON}"
python3 - "$EXTRACT_JSON" "$ROOT_DIR" <<'PY'
import json, pathlib, sys
payload_path, root = sys.argv[1], pathlib.Path(sys.argv[2])
with open(payload_path) as f:
    payload = json.load(f)
result_artifacts = [a for a in payload.get('artifacts', []) if a.get('kind') in ('result', 'extract-result')]
if not result_artifacts:
    raise SystemExit('missing extractor result artifact')
result_path = root / 'artifacts' / result_artifacts[0]['path'].replace('/artifacts/', '', 1)
with open(result_path) as f:
    result = json.load(f)
if result.get('title') != 'Example Domain' or result.get('htmlLength', 0) <= 0:
    raise SystemExit(f'extractor result did not honor schema params: {result}')
print(f"verified extractor result {result_path}")
PY

log "artifact/job API smoke"
JOB_ID="$(json_field "${EXTRACT_JSON}" job.id)"
ARTIFACT_ID="$(json_field "${EXTRACT_JSON}" artifacts.0.id)"
./cli/brs.js job "${JOB_ID}" >/tmp/brs-smoke-job-${TASK_PREFIX}.json
./cli/brs.js artifacts --leaseId "${JOB_ID}" >/tmp/brs-smoke-artifacts-${TASK_PREFIX}.json
./cli/brs.js artifact "${ARTIFACT_ID}" >/tmp/brs-smoke-artifact-${TASK_PREFIX}.json
./cli/brs.js artifact-download "${ARTIFACT_ID}" /tmp/brs-smoke-artifact-${TASK_PREFIX}.download >"${DOWNLOAD_JSON}"
./cli/brs.js cleanup-artifacts --olderThanDays 9999 >/tmp/brs-smoke-cleanup-${TASK_PREFIX}.json
python3 - "/tmp/brs-smoke-job-${TASK_PREFIX}.json" "/tmp/brs-smoke-artifacts-${TASK_PREFIX}.json" "${DOWNLOAD_JSON}" <<'PY'
import json, sys
job=json.load(open(sys.argv[1]))
artifacts=json.load(open(sys.argv[2]))['artifacts']
download=json.load(open(sys.argv[3]))
if job.get('status') != 'success' or not job.get('logs'):
    raise SystemExit(f'bad job detail: {job}')
if len(artifacts) < 3:
    raise SystemExit(f'expected >=3 artifacts: {artifacts}')
if download.get('bytes', 0) <= 0:
    raise SystemExit(f'bad artifact download: {download}')
print('verified job/artifact APIs')
PY

log "extractor error artifact smoke"
set +e
./cli/brs.js extract failing.extract.js "${TARGET_URL}" \
  --agent "${AGENT_ID}" \
  --task "${TASK_PREFIX}-error" \
  --humanize minimal \
  --params '{"reason":"smoke failure"}' \
  --max-attempts 2 >"${ERROR_EXTRACT_STDOUT}" 2>"${ERROR_EXTRACT_STDERR}"
ERROR_CODE=$?
set -e
if [[ "${ERROR_CODE}" -eq 0 ]]; then fail "failing extractor unexpectedly succeeded"; fi
python3 - "${ERROR_EXTRACT_STDERR}" <<'PY'
import json, re, sys
err=open(sys.argv[1]).read()
m=re.search(r'failed: 500 (\{.*\})$', err.strip(), re.S)
if not m:
    raise SystemExit(err)
payload=json.loads(m.group(1))
if payload.get('job', {}).get('status') != 'failed' or payload.get('job', {}).get('attempts') != 2:
    raise SystemExit(f'bad failed job payload: {payload}')
if 'INTENTIONAL_SMOKE_FAILURE' not in json.dumps(payload):
    raise SystemExit(f'failed extractor was masked by runtime error: {payload}')
if not any(a.get('kind') == 'error' and a.get('bytes', 0) > 0 for a in payload.get('artifacts', [])):
    raise SystemExit(f'missing error artifact: {payload}')
print('verified failed job retry + error artifacts')
PY

log "leased open/release smoke"
./cli/brs.js acquire \
  --agentId "${AGENT_ID}" \
  --taskId "${TASK_PREFIX}-lease" \
  --domain example.com >"${LEASE_JSON}"
LEASE_ID="$(json_field "${LEASE_JSON}" id)"
[[ -n "${LEASE_ID}" ]] || fail "lease id missing"
./cli/brs.js open "${LEASE_ID}" "${TARGET_URL}" --active false --humanize "${HUMANIZE_LEVEL}" >"${OPEN_JSON}"
python3 - "$OPEN_JSON" <<'PY'
import json, sys
with open(sys.argv[1]) as f:
    opened = json.load(f)
tab = opened.get('tab') or {}
if tab.get('groupId') in (None, -1):
    raise SystemExit(f"tab not grouped: {tab}")
print('verified grouped tab', tab.get('id'), 'group', tab.get('groupId'))
PY
./cli/brs.js release "${LEASE_ID}" >/tmp/brs-smoke-release-${TASK_PREFIX}.json
LEASE_ID=""

if [[ "${KEEP_STACK}" != "1" ]]; then
  log "compose down requested by BRS_SMOKE_KEEP_STACK=${KEEP_STACK}"
  docker compose down
fi

log "PASS"
printf 'Smoke artifacts:\n  %s\n  %s\n' "${FETCH_JSON}" "${EXTRACT_JSON}"
