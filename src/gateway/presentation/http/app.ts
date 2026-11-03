import express from 'express';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { AuthInfo, McpServerFactory } from '@modelcontextprotocol/server';
import type { Logger } from '../../../shared/logger.js';
import { isPlainPath } from '../../domain/request-policy.js';
import { AccessGate } from '../../application/access-gate.js';
import type { CanvasUpstream, RequestAuthenticator } from '../../application/ports.js';
import type { CanvasProxy } from '../../infrastructure/canvas-proxy.js';
import { MCP_AUTH_INFO_LOCAL, MCP_HTTP_PATH, createMcpHttpRouter } from './mcp-route.js';

/** Service name reported on `/health` when auth is on. */
export const GATEWAY_SERVICE = 'pizarra';

export interface GatewayAuth {
  /** OAuth metadata and `/oauth/*` endpoints. */
  router: express.Router;
  authenticator: RequestAuthenticator;
  /** Protected resource (audience) of `/mcp` and of the canvas behind it. */
  resource: string;
}

export interface GatewayAppOptions {
  bindHost: string;
  publicBaseUrl?: string;
  trustProxy: boolean | number | string;
  auth?: GatewayAuth;
  mcpFactory: McpServerFactory;
  upstream: CanvasUpstream;
  proxy: CanvasProxy;
  logger: Logger;
}

function single(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function gateHeaders(req: IncomingMessage) {
  return {
    authorization: single(req.headers.authorization),
    cookie: single(req.headers.cookie),
    origin: single(req.headers.origin),
    referer: single(req.headers.referer)
  };
}

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  const reason = status === 403 ? 'Forbidden' : status === 400 ? 'Bad Request' : 'Unauthorized';
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`);
}

/**
 * The gateway: the only public listener. In front of the upstream canvas it
 * serves the OAuth endpoints, `/mcp` (upstream's tools over Streamable HTTP),
 * a minimal `/health`, and reverse-proxies the canvas UI, REST API and
 * WebSocket after authentication. With auth off (loopback) it proxies
 * everything as is.
 */
export function createGatewayApp(options: GatewayAppOptions): { app: express.Express; onUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => void } {
  const { auth, upstream, proxy, logger } = options;
  const gate = auth ? new AccessGate(auth.authenticator, auth.resource) : undefined;
  const app = express();
  app.disable('x-powered-by');
  // Off unless TRUST_PROXY says otherwise: X-Forwarded-* is only honoured
  // behind a reverse proxy the operator controls.
  app.set('trust proxy', options.trustProxy);

  const forward: RequestHandler = (req, res) => proxy.web(req, res, req.originalUrl);

  app.get('/health', (req, res, next) => {
    if (!auth) return forward(req, res, next);
    // Unauthenticated: identify the service, reveal nothing else.
    res.setHeader('Cache-Control', 'no-store');
    const ready = upstream.isReady();
    res.status(ready ? 200 : 503).json({ status: ready ? 'healthy' : 'unhealthy', service: GATEWAY_SERVICE });
  });

  if (auth) app.use(auth.router);

  const mcpBearer: RequestHandler | undefined = auth ? (req, res, next) => {
    const result = auth.authenticator.authenticate(gateHeaders(req), { resource: auth.resource, acceptSession: false });
    if (!result.ok) {
      res.setHeader('WWW-Authenticate', result.challenge);
      res.status(result.status).json({ error: result.error });
      return;
    }
    const principal = result.principal;
    const authInfo: AuthInfo = {
      token: principal.token ?? '',
      clientId: principal.clientId ?? '',
      scopes: principal.scopes,
      ...(principal.expiresAt !== undefined ? { expiresAt: principal.expiresAt } : {}),
      ...(principal.resource ? { resource: new URL(principal.resource) } : {}),
      extra: { login: principal.login }
    };
    res.locals[MCP_AUTH_INFO_LOCAL] = authInfo;
    next();
  } : undefined;

  // Mounted before any body parser: the SDK reads the raw body itself.
  const { router: mcpRouter } = createMcpHttpRouter({
    factory: options.mcpFactory,
    logger,
    bindHost: options.bindHost,
    ...(options.publicBaseUrl ? { publicBaseUrl: options.publicBaseUrl } : {}),
    ...(mcpBearer ? { authMiddleware: [mcpBearer] } : {})
  });
  app.use(MCP_HTTP_PATH, mcpRouter);

  if (gate) {
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (!isPlainPath(req.path)) {
        res.status(400).json({ success: false, error: 'Bad request path' });
        return;
      }
      const verdict = gate.decide({ method: req.method, path: req.path, headers: gateHeaders(req) });
      if (verdict.kind === 'allow') return next();
      if (verdict.kind === 'login') {
        res.setHeader('Cache-Control', 'no-store');
        res.redirect(302, `/oauth/login?return_to=${encodeURIComponent(req.originalUrl)}`);
        return;
      }
      if (verdict.challenge) res.setHeader('WWW-Authenticate', verdict.challenge);
      res.status(verdict.status).json({ success: false, error: verdict.error });
    });
  }

  app.use(forward);

  app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
    // Client errors raised by middleware on the OAuth endpoints (413 body too
    // large, 400 malformed body) are the client's problem, not a failure.
    const status = (err as { status?: unknown; statusCode?: unknown }).status ?? (err as { statusCode?: unknown }).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      logger.warn('Rejected request', { status, method: req.method, path: req.path, type: (err as { type?: unknown }).type });
      if (res.headersSent) return next(err);
      res.status(status).json({ success: false, error: status === 413 ? 'Request body too large' : 'Bad request' });
      return;
    }
    logger.error('Unhandled error', { message: err.message, stack: err.stack });
    if (res.headersSent) return next(err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  });

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    if (gate) {
      const path = (req.url ?? '/').split('?')[0] ?? '/';
      if (!isPlainPath(path)) return rejectUpgrade(socket, 400, 'Bad request path');
      const verdict = gate.decideUpgrade(gateHeaders(req));
      if (!verdict.ok) return rejectUpgrade(socket, verdict.status, verdict.message);
    }
    proxy.upgrade(req, socket, head);
  };

  return { app, onUpgrade };
}
