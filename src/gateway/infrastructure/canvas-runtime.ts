import type { Logger } from '../../shared/logger.js';
import type { CanvasUpstream } from '../application/ports.js';
import { CanvasPool } from './canvas-pool.js';
import { migrateToBoardMain } from './legacy-layout.js';
import { PoolServer } from './pool-server.js';

export interface CanvasRuntimeOptions {
  logger: Logger;
  boardExists: (board: string) => boolean;
  dataDir?: string;
  /** CANVAS_DATA_DIR (board main's canvas), when set: nothing is migrated. */
  mainDataDir?: string;
  idleSeconds: number;
  maxOpen: number;
  /** Where the pool's front listens: loopback inside a gateway, the private network in the canvas container. */
  host: string;
  /** 0 picks a free port. */
  port: number;
}

/** The canvas pool and its front, as one upstream for gateways. */
export interface CanvasRuntime extends CanvasUpstream {
  readonly pool: CanvasPool;
  start(): Promise<void>;
  stop(): Promise<void>;
  killNow(): void;
}

/**
 * Starts the pool of board canvases (migrating a single-canvas data
 * directory to board main first) behind one listener.
 */
export function createCanvasRuntime(options: CanvasRuntimeOptions): CanvasRuntime {
  const pool = new CanvasPool({
    logger: options.logger,
    boardExists: options.boardExists,
    ...(options.dataDir ? { dataRoot: options.dataDir } : {}),
    ...(options.mainDataDir ? { mainDataDir: options.mainDataDir } : {}),
    idleMs: options.idleSeconds * 1000,
    maxOpen: options.maxOpen
  });
  const front = new PoolServer(pool, options.logger);
  const loopback = options.host === '0.0.0.0' || options.host === '::' ? '127.0.0.1' : options.host;
  return {
    pool,
    get host() { return loopback; },
    get port() { return front.port; },
    get baseUrl() { return `http://${loopback.includes(':') ? `[${loopback}]` : loopback}:${front.port}`; },
    isReady: () => pool.isReady(),
    async start() {
      if (options.dataDir && !options.mainDataDir) migrateToBoardMain(options.dataDir, 'canvas', options.logger);
      await pool.start();
      await front.listen(options.port, options.host);
    },
    async stop() {
      front.close();
      await pool.stop();
    },
    killNow() {
      pool.killNow();
    }
  };
}
