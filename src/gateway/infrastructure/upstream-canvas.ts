import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Logger } from '../../shared/logger.js';
import type { CanvasUpstream } from '../application/ports.js';
import { clearStaleCanvasLock } from './canvas-lock.js';

const require = createRequire(import.meta.url);
/** Upstream canvas entry point (the package has no `exports`, so the subpath resolves). */
export const UPSTREAM_SERVER_ENTRY = require.resolve('mcp-excalidraw-server/dist/server.js');
const GUARDIAN = pathToFileURL(fileURLToPath(new URL('./canvas-guardian.js', import.meta.url))).href;
/** The upstream identifies itself on /health with this service name. */
const UPSTREAM_SERVICE = 'mcp-excalidraw-canvas';
/** Environment the upstream may see: never the gateway's auth settings. */
const PASSED_ENV = ['PATH', 'HOME', 'TMPDIR', 'TZ', 'LANG', 'NODE_ENV', 'LOG_LEVEL', 'XDG_STATE_HOME', 'ENABLE_CANVAS_SYNC'];

export interface SupervisorOptions {
  port: number;
  logger: Logger;
  env?: Record<string, string | undefined>;
  /** Durable canvas state directory (upstream's `EXCALIDRAW_DATA_DIR`); none keeps the canvas in memory. */
  dataDir?: string;
  /** How long one start may take to answer /health. */
  startTimeoutMs?: number;
  /** Upper bound on the delay between restarts after a crash. */
  maxRestartDelayMs?: number;
}

/**
 * Runs the unmodified upstream canvas server as a child process bound to
 * 127.0.0.1 on an internal port, waits until /health answers for *this*
 * child (service name and pid), restarts it with backoff if it dies, and
 * kills it when the gateway stops.
 */
export class UpstreamCanvasSupervisor implements CanvasUpstream {
  readonly host = '127.0.0.1';
  readonly port: number;
  private child: ChildProcess | undefined;
  private ready = false;
  private stopping = false;
  private restartDelayMs = 1000;
  private restartTimer: NodeJS.Timeout | undefined;
  private readonly logger: Logger;
  private readonly env: Record<string, string | undefined>;
  private readonly startTimeoutMs: number;
  private readonly maxRestartDelayMs: number;
  private readonly dataDir: string | undefined;

  constructor(options: SupervisorOptions) {
    this.port = options.port;
    this.logger = options.logger;
    this.env = options.env ?? process.env;
    this.startTimeoutMs = options.startTimeoutMs ?? 15000;
    this.maxRestartDelayMs = options.maxRestartDelayMs ?? 30000;
    this.dataDir = options.dataDir;
  }

  get baseUrl(): string {
    return `http://${this.host}:${this.port}`;
  }

  isReady(): boolean {
    return this.ready;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  /** Starts the canvas; rejects if it does not become healthy in time. */
  async start(): Promise<void> {
    this.stopping = false;
    const child = this.spawnChild();
    await this.waitHealthy(child);
    this.ready = true;
    this.logger.info('Canvas upstream ready', { url: this.baseUrl, pid: child.pid });
  }

  private spawnChild(): ChildProcess {
    const env: Record<string, string> = {};
    for (const name of PASSED_ENV) {
      const value = this.env[name];
      if (value !== undefined) env[name] = value;
    }
    Object.assign(env, { HOST: this.host, PORT: String(this.port), EXCALIDRAW_NO_AUTOSTART: '1' });
    if (this.dataDir) {
      env.EXCALIDRAW_DATA_DIR = this.dataDir;
      const lock = clearStaleCanvasLock(this.dataDir);
      if (lock === 'cleared') this.logger.warn('Cleared a stale canvas data-directory lock', { dir: this.dataDir });
    }
    const child = spawn(process.execPath, ['--import', GUARDIAN, UPSTREAM_SERVER_ENTRY], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    const forward = (stream: NodeJS.ReadableStream | null) => {
      let buffer = '';
      stream?.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          if (line) this.logger.debug('canvas', { line: line.slice(0, 2000) });
        }
      });
    };
    forward(child.stdout);
    forward(child.stderr);
    child.once('exit', (code, signal) => {
      if (this.child === child) this.child = undefined;
      const wasReady = this.ready;
      this.ready = false;
      if (this.stopping) return;
      this.logger.warn('Canvas upstream exited', { code, signal });
      if (wasReady) this.scheduleRestart();
    });
    return child;
  }

  private scheduleRestart(): void {
    const delay = this.restartDelayMs;
    this.restartDelayMs = Math.min(this.restartDelayMs * 2, this.maxRestartDelayMs);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      if (this.stopping) return;
      this.start().then(() => {
        // Healthy for a minute: forget earlier crashes.
        setTimeout(() => { if (this.ready) this.restartDelayMs = 1000; }, 60_000).unref();
      }, error => {
        this.logger.error('Canvas upstream restart failed', { error: (error as Error).message });
        this.child?.kill('SIGKILL');
        this.scheduleRestart();
      });
    }, delay);
    this.restartTimer.unref();
  }

  private async waitHealthy(child: ChildProcess): Promise<void> {
    const deadline = Date.now() + this.startTimeoutMs;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`canvas upstream exited during startup (code ${child.exitCode}, signal ${child.signalCode})`);
      }
      try {
        const response = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(500) });
        const body = await response.json().catch(() => null) as { service?: unknown; pid?: unknown } | null;
        // Only our own child counts: a foreign listener on the port does not.
        if (response.ok && body?.service === UPSTREAM_SERVICE && body.pid === child.pid) return;
      } catch {
        // not up yet
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    child.kill('SIGKILL');
    throw new Error(`canvas upstream did not become healthy on ${this.baseUrl} within ${this.startTimeoutMs} ms`);
  }

  /** Stops the canvas (SIGTERM, then SIGKILL after a grace period). */
  async stop(graceMs = 3000): Promise<void> {
    this.stopping = true;
    this.ready = false;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); }, graceMs);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      child.kill('SIGTERM');
    });
  }

  /** Synchronous last resort for `process.on('exit')`. */
  killNow(): void {
    this.stopping = true;
    const child = this.child;
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}
