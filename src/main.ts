/**
 * Composition root: reads configuration, starts the upstream canvas on
 * loopback (or connects to one at CANVAS_URL), wires the auth module into the
 * gateway and listens. With PIZARRA_ROLE=canvas it only runs the canvas, for
 * gateways in other containers.
 */
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import net from 'node:net';
import { buildAuth, resolveAuthConfig } from './auth/index.js';
import { resolveGatewayConfig } from './config.js';
import { CanvasProxy } from './gateway/infrastructure/canvas-proxy.js';
import { RemoteCanvas } from './gateway/infrastructure/remote-canvas.js';
import { UpstreamCanvasSupervisor } from './gateway/infrastructure/upstream-canvas.js';
import { loadUpstreamMcpFactory } from './gateway/infrastructure/upstream-mcp.js';
import { MCP_HTTP_PATH } from './gateway/presentation/http/mcp-route.js';
import { createGatewayApp } from './gateway/presentation/http/app.js';
import { createLogger } from './shared/logger.js';

const logger = createLogger();

function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

function formatHost(host: string): string {
  return host.includes(':') ? `[${host}]` : host;
}

function onStopSignals(stop: (signal: string) => void): void {
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

/** PIZARRA_ROLE=canvas: only the upstream canvas, on CANVAS_BIND_HOST:CANVAS_INTERNAL_PORT. */
async function runCanvas(config: ReturnType<typeof resolveGatewayConfig>): Promise<void> {
  const canvas = new UpstreamCanvasSupervisor({
    port: config.canvasPort,
    bindHost: config.canvasBindHost,
    logger,
    ...(config.canvasDataDir ? { dataDir: config.canvasDataDir } : {})
  });
  process.on('exit', () => canvas.killNow());
  let stopping = false;
  onStopSignals(signal => {
    if (stopping) return;
    stopping = true;
    logger.info(`Received ${signal}, stopping the canvas`);
    void canvas.stop().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
  await canvas.start();
  logger.info('pizarra canvas listening', {
    url: `http://${formatHost(config.canvasBindHost)}:${config.canvasPort}`,
    canvasState: config.canvasDataDir ?? 'in memory (set EXCALIDRAW_DATA_DIR to keep it)'
  });
}

async function main(): Promise<void> {
  const config = resolveGatewayConfig(process.env);
  if (config.role === 'canvas') return runCanvas(config);
  const authConfig = resolveAuthConfig(config.host, process.env, { resourcePaths: [MCP_HTTP_PATH] });
  if (authConfig.mode === 'oauth') {
    for (const warning of authConfig.warnings) logger.warn(warning);
  } else if (authConfig.insecure) {
    logger.warn(`Authentication is OFF on non-loopback HOST=${config.host} (ALLOW_INSECURE_NO_AUTH=true): anyone who can reach this address can read and change the canvas.`);
  }
  const auth = authConfig.mode === 'oauth' ? buildAuth(authConfig, { logger }) : undefined;

  const upstream = config.canvasUrl
    ? new RemoteCanvas({ url: config.canvasUrl, logger })
    : new UpstreamCanvasSupervisor({
      port: config.canvasPort || await freeLoopbackPort(),
      logger,
      ...(config.canvasDataDir ? { dataDir: config.canvasDataDir } : {})
    });
  process.on('exit', () => upstream.killNow());
  await upstream.start();
  if (config.exportDir) mkdirSync(config.exportDir, { recursive: true, mode: 0o700 });
  const mcpFactory = await loadUpstreamMcpFactory(upstream.baseUrl, config.exportDir ? { exportDir: config.exportDir } : {});

  const { app, onUpgrade } = createGatewayApp({
    bindHost: config.host,
    ...(config.publicBaseUrl ? { publicBaseUrl: config.publicBaseUrl } : {}),
    trustProxy: config.trustProxy,
    ...(auth ? { auth: { router: auth.router, authenticator: auth.authenticator, resource: auth.settings.resources[0]! } } : {}),
    mcpFactory,
    upstream,
    proxy: new CanvasProxy(upstream, logger),
    logger
  });
  const server = createServer(app);
  server.on('upgrade', onUpgrade);

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Received ${signal}, shutting down`);
    server.close();
    server.closeAllConnections?.();
    void upstream.stop().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  onStopSignals(shutdown);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => resolve());
  });
  const local = `http://${formatHost(config.host)}:${config.port}`;
  logger.info('pizarra gateway listening', {
    url: local,
    mcp: `${config.publicBaseUrl ?? local}${MCP_HTTP_PATH}`,
    canvasState: config.canvasUrl ? `shared canvas at ${upstream.baseUrl}` : config.canvasDataDir ?? 'in memory (set EXCALIDRAW_DATA_DIR to keep it)',
    auth: auth ? `oauth (issuer ${auth.settings.issuer}, ${auth.settings.allowedLogins.size} allowed login(s))` : 'off'
  });
}

main().catch(error => {
  logger.error(`Startup failed: ${(error as Error).message}`);
  process.exit(1);
});
