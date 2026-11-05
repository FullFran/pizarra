import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Logger } from '../../shared/logger.js';
import { parseBoardPath } from '../domain/board-path.js';
import { isPlainPath } from '../domain/request-policy.js';
import { BoardNotFoundError, PoolFullError } from './canvas-pool.js';
import type { CanvasPool } from './canvas-pool.js';
import { CanvasProxy } from './canvas-proxy.js';

function splitUrl(url: string | undefined): { path: string; query: string } {
  const value = url ?? '/';
  const index = value.indexOf('?');
  return index < 0 ? { path: value, query: '' } : { path: value.slice(0, index), query: value.slice(index) };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function failure(error: unknown): { status: number; message: string } {
  if (error instanceof BoardNotFoundError) return { status: 404, message: 'Board not found' };
  if (error instanceof PoolFullError) return { status: 503, message: 'Too many open boards, try again later' };
  return { status: 502, message: 'Canvas unavailable' };
}

/**
 * The front of the canvas pool: one listener that routes `/b/<id>/...` to
 * that board's canvas (prefix removed) and every other path to board main,
 * exactly like the old single canvas, so a gateway (or one of an older
 * version) talks to it as it talked to the canvas. It has no authentication
 * of its own: it listens on loopback inside the gateway, or on a private
 * network in the canvas container, and only gateways reach it.
 */
export class PoolServer {
  readonly server: Server;
  private readonly proxy: CanvasProxy;

  constructor(private readonly pool: CanvasPool, private readonly logger: Logger) {
    this.proxy = new CanvasProxy({ host: '127.0.0.1', port: 0 }, logger);
    this.server = createServer((req, res) => { void this.web(req, res); });
    this.server.on('upgrade', (req, socket, head) => { void this.upgrade(req, socket, head); });
  }

  private route(url: string | undefined): { board: string; url: string } | undefined {
    const { path, query } = splitUrl(url);
    if (!isPlainPath(path)) return undefined;
    const parsed = parseBoardPath(path);
    if (parsed.kind === 'invalid') return undefined;
    return { board: parsed.board, url: `${parsed.rest}${query}` };
  }

  private async web(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const route = this.route(req.url);
    if (!route) return sendJson(res, 404, { success: false, error: 'Not found' });
    let target;
    try {
      target = await this.pool.acquire(route.board);
    } catch (error) {
      const { status, message } = failure(error);
      if (status === 502) this.logger.warn('Board canvas failed to open', { board: route.board, reason: (error as Error).message });
      return sendJson(res, status, { success: false, error: message });
    }
    this.proxy.web(req, res, route.url, { target });
  }

  private async upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const route = this.route(req.url);
    const refuse = (status: number, message: string): void => { socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); };
    if (!route) return refuse(404, 'Not Found');
    let target;
    try {
      target = await this.pool.acquire(route.board);
    } catch (error) {
      const { status, message } = failure(error);
      return refuse(status, message);
    }
    this.pool.hold(route.board);
    this.proxy.upgrade(req, socket, head, { target, url: route.url, onClose: () => this.pool.release(route.board) });
  }

  listen(port: number, host: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, host, () => resolve());
    });
  }

  get port(): number {
    const address = this.server.address();
    return typeof address === 'object' && address ? address.port : 0;
  }

  close(): void {
    this.server.close();
    this.server.closeAllConnections?.();
  }
}
