FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    DISPLAY_NUM=99 \
    VNC_PORT=5900 \
    NOVNC_PORT=6080 \
    CDP_PORT=9222 \
    SCREEN_WIDTH=1440 \
    SCREEN_HEIGHT=1000 \
    SCREEN_DEPTH=24 \
    FINGERPRINT_SEED=1000

ARG DEBIAN_MIRROR=http://deb.debian.org/debian
ARG DEBIAN_SECURITY_MIRROR=http://deb.debian.org/debian-security
RUN set -eux; \
    if [ -f /etc/apt/sources.list.d/debian.sources ]; then \
      sed -i "s|http://deb.debian.org/debian-security|${DEBIAN_SECURITY_MIRROR}|g" /etc/apt/sources.list.d/debian.sources; \
      sed -i "s|http://deb.debian.org/debian|${DEBIAN_MIRROR}|g" /etc/apt/sources.list.d/debian.sources; \
    else \
      printf '%s\n' \
        "deb ${DEBIAN_MIRROR} bookworm main" \
        "deb ${DEBIAN_MIRROR} bookworm-updates main" \
        "deb ${DEBIAN_SECURITY_MIRROR} bookworm-security main" \
        > /etc/apt/sources.list; \
    fi; \
    printf 'Acquire::Retries "5";\nAcquire::http::Timeout "30";\nAcquire::https::Timeout "30";\n' > /etc/apt/apt.conf.d/80-retries; \
    for attempt in 1 2 3; do \
      apt-get update && \
      apt-get install -y --no-install-recommends --fix-missing \
        xvfb x11vnc supervisor novnc websockify fonts-noto-cjk fonts-noto-color-emoji \
        chromium dbus-x11 procps socat curl ca-certificates && \
      break; \
      echo "apt install failed on attempt ${attempt}, retrying..."; \
      rm -rf /var/lib/apt/lists/*; \
      if [ "${attempt}" -eq 3 ]; then exit 1; fi; \
      sleep $((attempt * 5)); \
    done; \
    rm -rf /var/lib/apt/lists/*

RUN mkdir -p /data/user-data /var/log/supervisor /opt/browser-runtime-extension /opt/fingerprint-chromium
COPY supervisord.conf /etc/supervisor/conf.d/browser-runtime.conf
COPY entrypoint.sh /entrypoint.sh
COPY launch-browser.sh /launch-browser.sh
RUN chmod +x /entrypoint.sh /launch-browser.sh

EXPOSE 6080 19222
ENTRYPOINT ["/entrypoint.sh"]
