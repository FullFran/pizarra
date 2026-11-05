# pizarra: the authenticated gateway in front of the unmodified
# mcp-excalidraw-server canvas. Default image (last stage): one container,
# two processes, the gateway (the only listener on $PORT) and the upstream
# canvas it supervises on 127.0.0.1:$CANVAS_INTERNAL_PORT. Target `canvas`:
# the canvas alone, for gateways that set CANVAS_URL (zero-downtime deploys).
#
# Lessons kept from the fork's Dockerfile.canvas:
#   - @modelcontextprotocol/* stays in node_modules (/mcp needs the SDK);
#     the smoke test below imports it.
#   - /data is created and owned by the runtime user, so a fresh named
#     volume is writable (auth store, generated signing secret).
#   - resvg's native prebuild is swapped to musl for the alpine runtime,
#     so the upstream's headless PNG export works.

# ---- upstream: build the unmodified canvas at the commit pinned in upstream.json ----
# Upstream main has durable canvas state but no npm release yet, and its
# `dist/` is only produced by `prepublishOnly`, so it is cloned, checked
# against the pinned commit, built with its own lockfile and packed. The
# same script builds vendor/ for local development. Same Node line as local
# development, so the packed tarball matches package-lock.json's integrity.
FROM node:24-slim AS upstream
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends git ca-certificates >/dev/null && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY upstream.json ./
COPY scripts/build-upstream.sh ./scripts/
RUN ./scripts/build-upstream.sh && npm cache clean --force

# ---- build: compile TypeScript, then keep production dependencies only ----
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY --from=upstream /app/vendor ./vendor
RUN npm ci && npm cache clean --force
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
# Production node_modules, with the musl resvg binding co-located inside the
# resvg-js wrapper (js-binding.js loads a co-located resvgjs.<platform>.node
# first); the URL tracks the version npm resolved so the two never drift.
RUN VERS=$(node -p "require('./node_modules/@resvg/resvg-js/package.json').version") && \
    ARCH=$(case "$(uname -m)" in x86_64) echo x64 ;; aarch64) echo arm64 ;; *) echo unsupported ;; esac) && \
    [ "$ARCH" != "unsupported" ] && \
    npm prune --omit=dev && npm cache clean --force && \
    rm -f node_modules/@resvg/resvg-js/resvgjs.*.node && \
    rm -rf node_modules/@resvg/resvg-js-linux-x64-gnu node_modules/@resvg/resvg-js-linux-arm64-gnu && \
    apt-get update -qq && apt-get install -y -qq --no-install-recommends curl ca-certificates >/dev/null && \
    curl -fsSL "https://registry.npmjs.org/@resvg/resvg-js-linux-$ARCH-musl/-/resvg-js-linux-$ARCH-musl-$VERS.tgz" -o /tmp/resvg.tgz && \
    tar xz -C /tmp --strip-components=1 -f /tmp/resvg.tgz "package/resvgjs.linux-$ARCH-musl.node" && \
    cp /tmp/resvgjs.linux-$ARCH-musl.node node_modules/@resvg/resvg-js/ && \
    rm -f /tmp/resvg.tgz /tmp/resvgjs.linux-$ARCH-musl.node && \
    rm -rf vendor

# ---- base: alpine + Node from the alpine repo (no npm at runtime) ----
# Shared by both images below; everything here changes only with dependencies.
FROM alpine:3.23 AS base
RUN apk add --no-cache nodejs && \
    node -e "if (parseInt(process.versions.node, 10) < 20) { console.error('node ' + process.versions.node + ' < 20'); process.exit(1); }"
RUN addgroup -S -g 1001 pizarra && \
    adduser -S -u 1001 -G pizarra -h /home/pizarra pizarra && \
    mkdir -p /home/pizarra /app /data && chown pizarra:pizarra /home/pizarra /app /data && chmod 700 /data
ENV HOME=/home/pizarra
WORKDIR /app
USER pizarra
# Durable state: auth (token store, generated signing secret, mode 0600),
# boards.json, and each board's canvas and files in /data/boards/<id>/.
VOLUME ["/data"]

COPY --chown=pizarra:pizarra --from=build /app/package.json ./package.json
COPY --chown=pizarra:pizarra --from=build /app/node_modules ./node_modules

# Build-time smoke tests: a broken assumption fails the build, not production.
RUN node --input-type=module -e "await import('@modelcontextprotocol/server'); console.log('smoke: MCP SDK OK')" && \
    node -e "\
      const fs = require('fs');\
      const r = require('@resvg/resvg-js');\
      const png = new r.Resvg('<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"8\" height=\"8\"><rect width=\"8\" height=\"8\" fill=\"red\"/></svg>').render().asPng();\
      if (png.length < 40) throw new Error('resvg PNG too small');\
      for (const f of ['node_modules/mcp-excalidraw-server/dist/server.js', 'node_modules/mcp-excalidraw-server/dist/core/canvas-persistence.js', 'node_modules/mcp-excalidraw-server/dist/frontend/index.html', 'node_modules/mcp-excalidraw-server/assets/fonts/Excalifont-Regular.ttf']) if (!fs.existsSync(f)) throw new Error('missing ' + f);\
      console.log('smoke: resvg (musl) + upstream canvas (durable state) + frontend + fonts OK')"
ENV NODE_ENV=production \
    EXCALIDRAW_DATA_DIR=/data
LABEL org.opencontainers.image.source="https://github.com/FullFran/pizarra"
LABEL org.opencontainers.image.description="pizarra: authenticated gateway (OAuth 2.1 + GitHub sign-in) for the mcp-excalidraw-server whiteboard"
LABEL org.opencontainers.image.licenses="MIT"

# ---- canvas: only the pool of upstream canvases, for gateways that set CANVAS_URL ----
# Copies just the few compiled files the canvas role imports, so this image
# is byte-identical across gateway-only commits (COPY is cached by content)
# and a gateway deploy does not recreate the canvas container. Build it with
# `--target canvas`.
FROM base AS canvas
COPY --chown=pizarra:pizarra --from=build /app/dist/canvas-main.js /app/dist/config.js ./dist/
COPY --chown=pizarra:pizarra --from=build /app/dist/shared/network.js /app/dist/shared/logger.js /app/dist/shared/locked-json-file.js ./dist/shared/
COPY --chown=pizarra:pizarra --from=build /app/dist/boards ./dist/boards
COPY --chown=pizarra:pizarra --from=build /app/dist/gateway/domain/board-path.js /app/dist/gateway/domain/request-policy.js /app/dist/gateway/domain/framing.js /app/dist/gateway/domain/origins.js ./dist/gateway/domain/
COPY --chown=pizarra:pizarra --from=build /app/dist/gateway/infrastructure/upstream-canvas.js /app/dist/gateway/infrastructure/canvas-lock.js /app/dist/gateway/infrastructure/canvas-guardian.js /app/dist/gateway/infrastructure/canvas-pool.js /app/dist/gateway/infrastructure/pool-server.js /app/dist/gateway/infrastructure/canvas-proxy.js /app/dist/gateway/infrastructure/canvas-runtime.js /app/dist/gateway/infrastructure/legacy-layout.js ./dist/gateway/infrastructure/
RUN node --check dist/canvas-main.js
ENV PIZARRA_ROLE=canvas \
    CANVAS_BIND_HOST=0.0.0.0 \
    CANVAS_INTERNAL_PORT=3100
EXPOSE 3100
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3100/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"
CMD ["node", "dist/canvas-main.js"]

# ---- runtime (default, last stage): the gateway, with its own canvas unless CANVAS_URL is set ----
FROM base AS runtime
COPY --chown=pizarra:pizarra --from=build /app/dist ./dist
RUN node --check dist/main.js
ENV HOST=0.0.0.0 \
    PORT=3000 \
    CANVAS_INTERNAL_PORT=3100
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3000/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"
CMD ["node", "dist/main.js"]
