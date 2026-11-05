import net from 'node:net';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from '../../shared/logger.js';
import { DEFAULT_BOARD } from '../domain/board-path.js';
import { UpstreamCanvasSupervisor } from './upstream-canvas.js';

export class BoardNotFoundError extends Error {
  constructor(board: string) {
    super(`board ${board} does not exist`);
    this.name = 'BoardNotFoundError';
  }
}

export class PoolFullError extends Error {
  constructor(max: number) {
    super(`all ${max} open boards are in use`);
    this.name = 'PoolFullError';
  }
}

export interface CanvasPoolOptions {
  logger: Logger;
  /** Whether a board exists (the shared boards.json); only existing boards get a canvas. */
  boardExists: (board: string) => boolean;
  /** `EXCALIDRAW_DATA_DIR`: each board keeps its canvas in `<root>/boards/<id>/canvas`. None: every canvas in memory. */
  dataRoot?: string;
  /** Board main's canvas directory when `CANVAS_DATA_DIR` overrides it. */
  mainDataDir?: string;
  /** A board with no request and no open WebSocket for this long is stopped (main never is). */
  idleMs: number;
  /** At most this many canvases run at once (main included). */
  maxOpen: number;
  /** Where the canvases listen (the pool's front is what other containers reach). */
  bindHost?: string;
  startTimeoutMs?: number;
  /** Environment passed (filtered) to the canvases; tests only. */
  env?: Record<string, string | undefined>;
}

interface Entry {
  board: string;
  supervisor?: UpstreamCanvasSupervisor;
  starting?: Promise<UpstreamCanvasSupervisor>;
  lastUsed: number;
  connections: number;
}

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

/**
 * One unmodified upstream canvas per open board (upstream keeps one board
 * per process). A board's canvas starts on its first request, on its own
 * loopback port and data directory, and stops after `idleMs` without
 * requests or WebSockets; reopening it loads its durable state back. Board
 * main (today's canvas, the unprefixed alias) is started with the pool and
 * never idles. When `maxOpen` canvases run, opening another stops the least
 * recently used idle one, or fails with `PoolFullError` if every one is in use.
 */
export class CanvasPool {
  private readonly entries = new Map<string, Entry>();
  private sweeper: NodeJS.Timeout | undefined;
  private stopping = false;

  constructor(private readonly options: CanvasPoolOptions) {}

  /** Canvas directory of a board, or undefined (in memory). */
  dataDirOf(board: string): string | undefined {
    if (board === DEFAULT_BOARD && this.options.mainDataDir) return this.options.mainDataDir;
    return this.options.dataRoot ? join(this.options.dataRoot, 'boards', board, 'canvas') : undefined;
  }

  /** Starts board main and the idle sweeper. */
  async start(): Promise<void> {
    this.stopping = false;
    await this.acquire(DEFAULT_BOARD);
    const every = Math.max(250, Math.min(30_000, Math.floor(this.options.idleMs / 2)));
    this.sweeper = setInterval(() => { void this.sweep(); }, every);
    this.sweeper.unref();
  }

  /** Main's canvas is up (what `/health` reports). */
  isReady(): boolean {
    return this.entries.get(DEFAULT_BOARD)?.supervisor?.isReady() ?? false;
  }

  /** Main's canvas (its pid is what upstream's /health reports). */
  get main(): UpstreamCanvasSupervisor | undefined {
    return this.entries.get(DEFAULT_BOARD)?.supervisor;
  }

  openBoards(): string[] {
    return [...this.entries.keys()];
  }

  /** The running canvas of `board`, starting it if needed. */
  async acquire(board: string): Promise<UpstreamCanvasSupervisor> {
    if (this.stopping) throw new Error('the canvas pool is stopping');
    let entry = this.entries.get(board);
    if (entry) {
      entry.lastUsed = Date.now();
      if (entry.supervisor) return entry.supervisor;
      return entry.starting!;
    }
    if (!this.options.boardExists(board)) throw new BoardNotFoundError(board);
    if (this.entries.size >= this.options.maxOpen) await this.evictOne();
    entry = { board, lastUsed: Date.now(), connections: 0 };
    this.entries.set(board, entry);
    const current = entry;
    current.starting = this.spawn(board).then(supervisor => {
      current.supervisor = supervisor;
      current.starting = undefined;
      return supervisor;
    }, error => {
      if (this.entries.get(board) === current) this.entries.delete(board);
      throw error;
    });
    return current.starting;
  }

  private async spawn(board: string): Promise<UpstreamCanvasSupervisor> {
    const dataDir = this.dataDirOf(board);
    if (dataDir) mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const supervisor = new UpstreamCanvasSupervisor({
      port: await freeLoopbackPort(),
      logger: this.options.logger,
      ...(this.options.env ? { env: this.options.env } : {}),
      ...(dataDir ? { dataDir } : {}),
      ...(this.options.startTimeoutMs ? { startTimeoutMs: this.options.startTimeoutMs } : {})
    });
    await supervisor.start();
    this.options.logger.info('Board canvas opened', { board, pid: supervisor.pid });
    return supervisor;
  }

  /** Counts an open WebSocket (keeps the board from idling) until `release`. */
  hold(board: string): void {
    const entry = this.entries.get(board);
    if (entry) {
      entry.connections += 1;
      entry.lastUsed = Date.now();
    }
  }

  release(board: string): void {
    const entry = this.entries.get(board);
    if (entry) {
      entry.connections = Math.max(0, entry.connections - 1);
      entry.lastUsed = Date.now();
    }
  }

  private idle(entry: Entry): boolean {
    return entry.board !== DEFAULT_BOARD && entry.connections === 0 && entry.supervisor !== undefined;
  }

  private async evictOne(): Promise<void> {
    const candidates = [...this.entries.values()].filter(entry => this.idle(entry)).sort((a, b) => a.lastUsed - b.lastUsed);
    const victim = candidates[0];
    if (!victim) throw new PoolFullError(this.options.maxOpen);
    await this.close(victim, 'cap');
  }

  private async close(entry: Entry, reason: 'idle' | 'cap'): Promise<void> {
    if (this.entries.get(entry.board) !== entry) return;
    this.entries.delete(entry.board);
    await entry.supervisor?.stop();
    this.options.logger.info('Board canvas closed', { board: entry.board, reason });
  }

  private async sweep(): Promise<void> {
    const cutoff = Date.now() - this.options.idleMs;
    for (const entry of [...this.entries.values()]) {
      if (this.idle(entry) && entry.lastUsed < cutoff) await this.close(entry, 'idle');
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.sweeper) clearInterval(this.sweeper);
    const entries = [...this.entries.values()];
    this.entries.clear();
    await Promise.all(entries.map(async entry => {
      const supervisor = entry.supervisor ?? await entry.starting?.catch(() => undefined);
      await supervisor?.stop();
    }));
  }

  killNow(): void {
    this.stopping = true;
    for (const entry of this.entries.values()) entry.supervisor?.killNow();
  }
}
