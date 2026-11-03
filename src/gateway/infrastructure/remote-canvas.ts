import type { Logger } from '../../shared/logger.js';
import type { CanvasUpstream } from '../application/ports.js';
import { UPSTREAM_SERVICE } from './upstream-canvas.js';

export interface RemoteCanvasOptions {
  url: URL;
  logger: Logger;
  /** How often /health of the canvas is checked. */
  intervalMs?: number;
  /** How long `start` waits for the canvas to answer before giving up. */
  startTimeoutMs?: number;
}

/**
 * A canvas run by another process (`PIZARRA_ROLE=canvas`, usually its own
 * container), reached at CANVAS_URL. Several gateways can share it: the
 * canvas state then lives in exactly one place. Readiness follows its
 * /health, so the gateway's own /health says 503 while the canvas is down.
 */
export class RemoteCanvas implements CanvasUpstream {
  readonly host: string;
  readonly port: number;
  private ready = false;
  private timer: NodeJS.Timeout | undefined;
  private readonly logger: Logger;
  private readonly intervalMs: number;
  private readonly startTimeoutMs: number;

  constructor(options: RemoteCanvasOptions) {
    this.host = options.url.hostname.replace(/^\[(.*)\]$/, '$1');
    this.port = Number(options.url.port);
    this.logger = options.logger;
    this.intervalMs = options.intervalMs ?? 2000;
    this.startTimeoutMs = options.startTimeoutMs ?? 60_000;
  }

  get baseUrl(): string {
    return `http://${this.host.includes(':') ? `[${this.host}]` : this.host}:${this.port}`;
  }

  isReady(): boolean {
    return this.ready;
  }

  private async check(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(1000) });
      const body = await response.json().catch(() => null) as { service?: unknown } | null;
      return response.ok && body?.service === UPSTREAM_SERVICE;
    } catch {
      return false;
    }
  }

  private async tick(): Promise<void> {
    const ready = await this.check();
    if (ready !== this.ready) {
      if (ready) this.logger.info('Canvas reachable', { url: this.baseUrl });
      else this.logger.warn('Canvas unreachable', { url: this.baseUrl });
    }
    this.ready = ready;
  }

  /** Waits until the canvas answers, then keeps watching it. */
  async start(): Promise<void> {
    const deadline = Date.now() + this.startTimeoutMs;
    while (!(await this.check())) {
      if (Date.now() > deadline) throw new Error(`canvas at ${this.baseUrl} did not answer /health within ${this.startTimeoutMs} ms`);
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    this.ready = true;
    this.logger.info('Canvas reachable', { url: this.baseUrl });
    const loop = () => {
      this.timer = setTimeout(() => { void this.tick().finally(loop); }, this.intervalMs);
      this.timer.unref();
    };
    loop();
  }

  async stop(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.ready = false;
  }

  killNow(): void {
    if (this.timer) clearTimeout(this.timer);
  }
}
