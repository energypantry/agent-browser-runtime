FROM golang:1.21-alpine AS builder

WORKDIR /build
ARG ALPINE_MIRROR=https://dl-cdn.alpinelinux.org/alpine
RUN sed -i "s|https://dl-cdn.alpinelinux.org/alpine|${ALPINE_MIRROR}|g" /etc/apk/repositories
RUN apk add --no-cache git ca-certificates

# Copy dependency definitions first to keep Docker layer caching useful.
COPY go.mod go.sum ./
ARG GOPROXY=https://proxy.golang.org,direct
RUN GOPROXY="${GOPROXY}" go mod download

# Copy source after dependencies.
COPY *.go ./

# Build a static gateway binary for the current Docker platform.
ARG TARGETOS=linux
ARG TARGETARCH
RUN target_arch="${TARGETARCH:-$(go env GOARCH)}"; \
    CGO_ENABLED=0 GOOS="${TARGETOS}" GOARCH="${target_arch}" GOPROXY="${GOPROXY}" go build -ldflags='-s -w' -o tls-gateway .

FROM golang:1.21-alpine AS runtime

ARG ALPINE_MIRROR=https://dl-cdn.alpinelinux.org/alpine
RUN sed -i "s|https://dl-cdn.alpinelinux.org/alpine|${ALPINE_MIRROR}|g" /etc/apk/repositories
RUN apk add --no-cache ca-certificates tzdata curl
WORKDIR /app
COPY --from=builder /build/tls-gateway /app/tls-gateway

EXPOSE 8080

ENV LISTEN_ADDR=0.0.0.0:8080 \
    LOG_LEVEL=info \
    JA3_PROFILE=Chrome-124-macOS \
    ENABLE_SESSIONS=true \
    SESSION_TTL=1h \
    ENABLE_PROXY_CHAIN=false \
    PROXY_CHAIN=

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD curl -fsS http://127.0.0.1:8080/health || exit 1

ENTRYPOINT ["/app/tls-gateway"]
CMD []
