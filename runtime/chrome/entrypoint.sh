#!/bin/bash
set -euo pipefail
export DISPLAY=:${DISPLAY_NUM:-99}
echo "=== browser-runtime-skill chrome-runtime ==="
echo "Display: $DISPLAY"
echo "Screen: ${SCREEN_WIDTH}x${SCREEN_HEIGHT}x${SCREEN_DEPTH}"
echo "noVNC: ${NOVNC_PORT} | CDP proxy: 19222 -> ${CDP_PORT}"
echo "Extension dir: ${BROWSER_EXTENSION_DIR:-/opt/browser-runtime-extension}"
exec /usr/bin/supervisord -c /etc/supervisor/conf.d/browser-runtime.conf
