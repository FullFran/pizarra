/**
 * Composition root: reads configuration, opens the boards, starts the pool
 * of board canvases on loopback (or connects to one at CANVAS_URL), wires
 * the auth plugins and the boards into the gateway and listens. With
 * PIZARRA_ROLE=canvas it only runs the canvas pool, for gateways in other
 * containers.
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAuth, resolveAuthConfig } from './auth/index.js';
import { MAIN_BOARD, buildBoards } from './boards/index.js';
import { boardDirectory, boardsAccessPolicy } from './composition.js';
import { resolveGatewayConfig } from './config.js';
import { CanvasProxy } from './gateway/infrastructure/canvas-proxy.js';
import { createCanvasRuntime } from './gateway/infrastructure/canvas-runtime.js';
import { migrateToBoardMain } from './gateway/infrastructure/legacy-layout.js';
import { RemoteCanvas } from './gateway/infrastructure/remote-canvas.js';
import { BoardMcpFactories } from './gateway/infrastructure/upstream-mcp.js';
import { MCP_HTTP_PATH } from './gateway/presentation/http/mcp-route.js';
import { createGatewayApp } from './gateway/presentation/http/app.js';
import { framingHeaders } from './gateway/domain/framing.js';
import { createLogger } from './shared/logger.js';

const logger = createLogger();

function formatHost(host: string): string {
  return host.includes(':') ? `[${host}]` : host;
}

function onStopSignals(stop: (signal: string) => void): void {
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

async function main(): Promise<void> {
  const config = resolveGatewayConfig(process.env);
  if (config.role === 'canvas') {
    // Same entry as the canvas image (Dockerfile target `canvas`).
    await import('./canvas-main.js');
    return;
  }
  const authConfig = resolveAuthConfig(config.host, process.env, { resourcePaths: [MCP_HTTP_PATH] });
  if (authConfig.mode === 'oauth') {
    for (const warning of authConfig.warnings) logger.warn(warning);
  } else if (authConfig.insecure) {
    logger.warn(`Authentication is OFF on non-loopback HOST=${config.host} (ALLOW_INSECURE_NO_AUTH=true): anyone who can reach this address can read and change every board.`);
  }

  if (config.dataDir) mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const boards = buildBoards({
    ...(config.dataDir ? { dataDir: config.dataDir } : {}),
    admins: authConfig.mode === 'oauth' ? authConfig.settings.allowedLogins : { has: () => false }
  });
  boards.ensureMain();
  const auth = authConfig.mode === 'oauth'
    ? buildAuth(authConfig, { logger, policy: boardsAccessPolicy(boards, authConfig.settings.issuer), admission: boards })
    : undefined;

  const upstream = config.canvasUrl
    ? new RemoteCanvas({ url: config.canvasUrl, logger })
    : createCanvasRuntime({
      logger,
      boardExists: board => boards.exists(board),
      ...(config.dataDir ? { dataDir: config.dataDir } : {}),
      ...(config.canvasDataDir ? { mainDataDir: config.canvasDataDir } : {}),
      idleSeconds: config.boardIdleSeconds,
      maxOpen: config.maxOpenBoards,
      host: '127.0.0.1',
      port: config.canvasPort
    });
  process.on('exit', () => upstream.killNow());
  await upstream.start();
  await auth?.warmUp();

  // MCP file tools: each board has its own export directory.
  if (config.dataDir && !config.exportDir) migrateToBoardMain(config.dataDir, 'files', logger);
  const scratchRoot = config.dataDir ? undefined : mkdtempSync(join(tmpdir(), 'pizarra-files-'));
  const exportDirOf = (board: string): string => {
    if (board === MAIN_BOARD && config.exportDir) return config.exportDir;
    return config.dataDir ? join(config.dataDir, 'boards', board, 'files') : join(scratchRoot!, board);
  };
  const mcp = new BoardMcpFactories({ canvasBaseUrl: upstream.baseUrl, exportDirOf });

  const { app, onUpgrade } = createGatewayApp({
    bindHost: config.host,
    ...(config.publicBaseUrl ? { publicBaseUrl: config.publicBaseUrl } : {}),
    trustProxy: config.trustProxy,
    ...(auth ? {
      auth: {
        router: auth.router,
        authenticator: auth.authenticator,
        resource: auth.settings.resources[0]!,
        ...(auth.providers.includes('github') ? { signInPath: '/oauth/login' } : {})
      }
    } : {}),
    mcpFactoryFor: board => mcp.get(board),
    boards: boardDirectory(boards),
    upstream,
    proxy: new CanvasProxy(upstream, logger),
    logger,
    framing: (headers, kind) => {
      const upstreamCsp = headers['content-security-policy'];
      const policy = framingHeaders(kind, config.frameAncestors, typeof upstreamCsp === 'string' ? upstreamCsp : undefined);
      headers['content-security-policy'] = policy.csp;
      if (policy.xFrameOptions) headers['x-frame-options'] = policy.xFrameOptions;
      else delete headers['x-frame-options'];
    }
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
    canvasState: config.canvasUrl ? `shared canvas pool at ${upstream.baseUrl}` : config.dataDir ?? 'in memory (set EXCALIDRAW_DATA_DIR to keep it)',
    auth: auth ? `${auth.providers.join(', ')} (issuer ${auth.settings.issuer}, ${auth.settings.allowedLogins.size} admin(s))` : 'off'
  });
}

main().catch(error => {
  logger.error(`Startup failed: ${(error as Error).message}`);
  process.exit(1);
});
