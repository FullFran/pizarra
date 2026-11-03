/**
 * Entry point of the canvas role (`PIZARRA_ROLE=canvas`, and the Dockerfile
 * target `canvas`): runs only the unmodified upstream canvas on
 * CANVAS_BIND_HOST:CANVAS_INTERNAL_PORT with `<data>/canvas`, for gateways in
 * other containers that set CANVAS_URL. It imports as little as possible, so
 * the canvas image only changes when the canvas side changes, and a gateway
 * deploy does not restart the canvas.
 */
import { resolveGatewayConfig } from './config.js';
import { UpstreamCanvasSupervisor } from './gateway/infrastructure/upstream-canvas.js';
import { createLogger } from './shared/logger.js';

const logger = createLogger();

async function runCanvas(): Promise<void> {
  const config = resolveGatewayConfig({ ...process.env, PIZARRA_ROLE: 'canvas' });
  const canvas = new UpstreamCanvasSupervisor({
    port: config.canvasPort,
    bindHost: config.canvasBindHost,
    logger,
    ...(config.canvasDataDir ? { dataDir: config.canvasDataDir } : {})
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
  logger.info('pizarra canvas listening', {
    url: `http://${host}:${config.canvasPort}`,
    canvasState: config.canvasDataDir ?? 'in memory (set EXCALIDRAW_DATA_DIR to keep it)'
  });
}

runCanvas().catch(error => {
  logger.error(`Canvas startup failed: ${(error as Error).message}`);
  process.exit(1);
});
