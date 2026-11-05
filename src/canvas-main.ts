/**
 * Entry point of the canvas role (`PIZARRA_ROLE=canvas`, and the Dockerfile
 * target `canvas`): runs only the pool of unmodified upstream canvases (one
 * per open board, `<data>/boards/<id>/canvas`) behind one listener on
 * CANVAS_BIND_HOST:CANVAS_INTERNAL_PORT, for gateways in other containers
 * that set CANVAS_URL. It imports as little as possible, so the canvas
 * image only changes when the canvas side changes, and a gateway deploy
 * does not restart the canvas.
 */
import { buildBoards } from './boards/index.js';
import { resolveGatewayConfig } from './config.js';
import { createCanvasRuntime } from './gateway/infrastructure/canvas-runtime.js';
import { createLogger } from './shared/logger.js';

const logger = createLogger();

async function runCanvas(): Promise<void> {
  const config = resolveGatewayConfig({ ...process.env, PIZARRA_ROLE: 'canvas' });
  // boards.json is written by the gateways; the canvas only reads which boards exist.
  const boards = buildBoards({ ...(config.dataDir ? { dataDir: config.dataDir } : {}), admins: { has: () => false } });
  boards.ensureMain();
  const canvas = createCanvasRuntime({
    logger,
    boardExists: board => boards.exists(board),
    ...(config.dataDir ? { dataDir: config.dataDir } : {}),
    ...(config.canvasDataDir ? { mainDataDir: config.canvasDataDir } : {}),
    idleSeconds: config.boardIdleSeconds,
    maxOpen: config.maxOpenBoards,
    host: config.canvasBindHost,
    port: config.canvasPort
  });
  process.on('exit', () => canvas.killNow());
  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info(`Received ${signal}, stopping the canvas`);
    void canvas.stop().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
  await canvas.start();
  const host = config.canvasBindHost.includes(':') ? `[${config.canvasBindHost}]` : config.canvasBindHost;
  logger.info('pizarra canvas pool listening', {
    url: `http://${host}:${config.canvasPort}`,
    canvasState: config.dataDir ?? 'in memory (set EXCALIDRAW_DATA_DIR to keep it)'
  });
}

runCanvas().catch(error => {
  logger.error(`Canvas startup failed: ${(error as Error).message}`);
  process.exit(1);
});
