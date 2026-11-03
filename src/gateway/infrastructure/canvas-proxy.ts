import http from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Logger } from '../../shared/logger.js';
import type { CanvasUpstream } from '../application/ports.js';

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-connection', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade'
]);
/** The gateway's credentials stay at the gateway: upstream never sees them. */
const CREDENTIAL_HEADERS = new Set(['authorization', 'cookie']);

function connectionTokens(headers: IncomingHttpHeaders): Set<string> {
  const value = headers.connection;
  const list = Array.isArray(value) ? value.join(',') : value ?? '';
  return new Set(list.split(',').map(token => token.trim().toLowerCase()).filter(Boolean));
}

function requestHeaders(req: IncomingMessage, upstream: CanvasUpstream): OutgoingHttpHeaders {
  const listed = connectionTokens(req.headers);
  const headers: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || HOP_BY_HOP.has(name) || listed.has(name) || CREDENTIAL_HEADERS.has(name) || name === 'host') continue;
    headers[name] = value;
  }
  headers.host = `${upstream.host}:${upstream.port}`;
  return headers;
}

function responseHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const listed = connectionTokens(headers);
  const result: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    // Upstream must not set cookies on the gateway's origin.
    if (value === undefined || HOP_BY_HOP.has(name) || listed.has(name) || name === 'set-cookie') continue;
    result[name] = value;
  }
  return result;
}

/**
 * Reverse proxy to the loopback canvas with Node's own `http` (no extra
 * dependency): streams requests and responses, and tunnels WebSocket
 * upgrades. Only called after the gateway has authenticated the request.
 */
export class CanvasProxy {
  constructor(private readonly upstream: CanvasUpstream, private readonly logger: Logger) {}

  web(req: IncomingMessage, res: ServerResponse, url: string): void {
    const proxyReq = http.request({
      host: this.upstream.host,
      port: this.upstream.port,
      method: req.method,
      path: url,
      headers: requestHeaders(req, this.upstream),
      agent: false
    }, proxyRes => {
      res.writeHead(proxyRes.statusCode ?? 502, responseHeaders(proxyRes.headers));
      proxyRes.pipe(res);
      proxyRes.on('error', () => res.destroy());
    });
    proxyReq.on('error', error => {
      this.logger.warn('Canvas upstream request failed', { reason: error.message });
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ success: false, error: 'Canvas unavailable' }));
      } else {
        res.destroy();
      }
    });
    res.on('close', () => { if (!res.writableFinished) proxyReq.destroy(); });
    req.pipe(proxyReq);
  }

  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const headers = requestHeaders(req, this.upstream);
    headers.connection = 'Upgrade';
    headers.upgrade = req.headers.upgrade ?? 'websocket';
    const proxyReq = http.request({
      host: this.upstream.host,
      port: this.upstream.port,
      method: req.method,
      path: req.url,
      headers,
      agent: false
    });
    const fail = (status: number, message: string) => {
      if (socket.writable) socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      else socket.destroy();
    };
    proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
      const lines = [`HTTP/1.1 101 ${proxyRes.statusMessage ?? 'Switching Protocols'}`];
      for (let i = 0; i < proxyRes.rawHeaders.length; i += 2) {
        const name = proxyRes.rawHeaders[i]!;
        if (name.toLowerCase() === 'set-cookie') continue;
        lines.push(`${name}: ${proxyRes.rawHeaders[i + 1]}`);
      }
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (proxyHead.length > 0) socket.write(proxyHead);
      if (head.length > 0) proxySocket.write(head);
      proxySocket.pipe(socket);
      socket.pipe(proxySocket);
      const close = () => { proxySocket.destroy(); socket.destroy(); };
      proxySocket.on('error', close);
      socket.on('error', close);
      proxySocket.on('close', close);
      socket.on('close', close);
    });
    proxyReq.on('response', proxyRes => {
      fail(proxyRes.statusCode ?? 502, proxyRes.statusMessage ?? 'Bad Gateway');
      proxyRes.resume();
    });
    proxyReq.on('error', error => {
      this.logger.warn('Canvas upstream WebSocket failed', { reason: error.message });
      fail(502, 'Bad Gateway');
    });
    socket.on('error', () => proxyReq.destroy());
    proxyReq.end();
  }
}
