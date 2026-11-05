import express from 'express';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { IncomingMessage, OutgoingHttpHeaders } from 'node:http';
import type { Duplex } from 'node:stream';
import type { AuthInfo, McpServerFactory } from '@modelcontextprotocol/server';
import type { Logger } from '../../../shared/logger.js';
import { DEFAULT_BOARD, parseBoardPath } from '../../domain/board-path.js';
import { isPlainPath, isSafeMethod, isSameOrigin } from '../../domain/request-policy.js';
import { toolsRefusedToViewer } from '../../domain/viewer-policy.js';
import { AccessGate } from '../../application/access-gate.js';
import type { BoardDirectory, BoardRole, CanvasUpstream, Principal, RequestAuthenticator } from '../../application/ports.js';
import type { CanvasProxy } from '../../infrastructure/canvas-proxy.js';
import { dropDataFrames } from '../../infrastructure/websocket-filter.js';
import { BOARD_SCRIPT, BOARD_SCRIPT_PATH, fetchBoardPage, injectBoardScript } from './board-page.js';
import { MCP_AUTH_INFO_LOCAL, MCP_HTTP_PATH, createMcpHttpRouter } from './mcp-route.js';
import { createMembersRouter } from './members.js';
import { sendOutcome } from './responses.js';
import type { SessionCheck } from './responses.js';

/** Service name reported on `/health` when auth is on. */
export const GATEWAY_SERVICE = 'pizarra';

export interface GatewayAuth {
  /** OAuth metadata, `/oauth/*` and every auth provider's own endpoints. */
  router: express.Router;
  authenticator: RequestAuthenticator;
  /** Protected resource (audience) of `/mcp`, i.e. of board main. */
  resource: string;
  /** Where a browser without a session signs in (GitHub provider); none: 401. */
  signInPath?: string;
}

/** Framing policy for a response (docs/auth.md, "Embedding boards"). */
export type Framing = (headers: OutgoingHttpHeaders, kind: 'board' | 'other') => void;

export interface GatewayAppOptions {
  bindHost: string;
  publicBaseUrl?: string;
  trustProxy: boolean | number | string;
  auth?: GatewayAuth;
  /** Upstream's MCP server factory for a board. */
  mcpFactoryFor: (board: string) => Promise<McpServerFactory>;
  boards: BoardDirectory;
  upstream: CanvasUpstream;
  proxy: CanvasProxy;
  logger: Logger;
  framing?: Framing;
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
  const reason = status === 403 ? 'Forbidden' : status === 400 ? 'Bad Request' : status === 404 ? 'Not Found' : 'Unauthorized';
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`);
}

/**
 * The gateway: the only public listener. In front of the canvas pool it
 * serves the auth endpoints, MCP for every board (`/b/<id>/mcp`, and `/mcp`
 * for main), the boards API, a minimal `/health`, and reverse-proxies each
 * board's canvas UI, REST API and WebSocket (`/b/<id>/...`; unprefixed paths
 * are board main) after authentication and the board's own access rules.
 * With auth off (loopback) everyone owns every board.
 */
export function createGatewayApp(options: GatewayAppOptions): { app: express.Express; onUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => void } {
  const { auth, upstream, proxy, logger, boards } = options;
  const resourcesOf = (board: string): string[] => {
    if (!auth) return [];
    const origin = auth.authenticator.origin;
    return board === DEFAULT_BOARD ? [auth.resource, `${origin}/b/${DEFAULT_BOARD}/mcp`] : [`${origin}/b/${board}/mcp`];
  };
  const gate = auth ? new AccessGate(auth.authenticator, { resources: resourcesOf, boards }) : undefined;
  const framing: Framing = options.framing ?? (() => {});
  const app = express();
  app.disable('x-powered-by');
  // Off unless TRUST_PROXY says otherwise: X-Forwarded-* is only honoured
  // behind a reverse proxy the operator controls.
  app.set('trust proxy', options.trustProxy);

  const forward = (req: Request, res: Response, kind: 'board' | 'other' = 'board'): void =>
    proxy.web(req, res, req.originalUrl, { adjust: headers => framing(headers, kind) });

  app.get('/health', (req, res) => {
    if (!auth) return forward(req, res, 'other');
    // Unauthenticated: identify the service, reveal nothing else.
    res.setHeader('Cache-Control', 'no-store');
    const ready = upstream.isReady();
    res.status(ready ? 200 : 503).json({ status: ready ? 'healthy' : 'unhealthy', service: GATEWAY_SERVICE });
  });

  // No secret in it: the same script for every board page.
  app.get(BOARD_SCRIPT_PATH, (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.status(200).type('application/javascript').send(BOARD_SCRIPT);
  });

  if (auth) app.use(auth.router);

  // ---- MCP: /mcp is board main, /b/<id>/mcp every board ----
  const mcpAuth: RequestHandler = async (req, res, next) => {
    const board = res.locals.board as string;
    if (!auth) {
      if (!boards.exists(board)) {
        res.status(404).json({ success: false, error: 'Board not found' });
        return;
      }
      return next();
    }
    try {
      await auth.authenticator.prepare?.(gateHeaders(req));
    } catch (error) {
      return next(error);
    }
    const result = auth.authenticator.authenticate(gateHeaders(req), { resource: resourcesOf(board), acceptSession: false, board });
    if (!result.ok) {
      res.setHeader('WWW-Authenticate', result.challenge);
      res.status(result.status).json({ error: result.error });
      return;
    }
    const principal = result.principal;
    const role = boards.summary(board, principal)?.role;
    if (!role) {
      res.status(404).json({ success: false, error: 'Board not found' });
      return;
    }
    res.locals.role = role;
    const authInfo: AuthInfo = {
      token: principal.token ?? '',
      clientId: principal.clientId ?? '',
      scopes: principal.scopes,
      ...(principal.expiresAt !== undefined ? { expiresAt: principal.expiresAt } : {}),
      ...(principal.resource ? { resource: new URL(principal.resource) } : {}),
      extra: { login: principal.login, board, role, ...(principal.provider ? { provider: principal.provider } : {}) }
    };
    res.locals[MCP_AUTH_INFO_LOCAL] = authInfo;
    next();
  };
  const viewerToolFilter: RequestHandler = (req, res, next) => {
    if ((res.locals.role as BoardRole | undefined) !== 'viewer') return next();
    let body: unknown;
    try {
      body = Buffer.isBuffer(req.body) && req.body.length > 0 ? JSON.parse(req.body.toString('utf8')) : undefined;
    } catch {
      return next();
    }
    const refused = toolsRefusedToViewer(body);
    if (refused.length === 0) return next();
    const id = !Array.isArray(body) && body && typeof body === 'object' ? (body as { id?: unknown }).id ?? null : null;
    res.status(403).json({ jsonrpc: '2.0', id, error: { code: -32001, message: `This board is read-only for you: ${refused.join(', ')} not allowed` } });
  };
  // Mounted before any body parser: the SDK reads the raw body itself.
  const { router: mcpRouter } = createMcpHttpRouter({
    factoryFor: async res => (boards.exists(res.locals.board as string) ? options.mcpFactoryFor(res.locals.board as string) : undefined),
    logger,
    bindHost: options.bindHost,
    ...(options.publicBaseUrl ? { publicBaseUrl: options.publicBaseUrl } : {}),
    authMiddleware: [mcpAuth],
    bodyFilter: viewerToolFilter
  });
  app.use(MCP_HTTP_PATH, (_req, res, next) => { res.locals.board = DEFAULT_BOARD; next(); }, mcpRouter);
  app.use('/b/:board/mcp', (req, res, next) => {
    const board = req.params.board ?? '';
    // Express matches case-insensitively: only the exact lowercase /b/<valid id>/mcp counts.
    const route = parseBoardPath(req.baseUrl);
    if (route.kind !== 'board' || !route.prefixed || route.board !== board || route.rest !== '/mcp') {
      res.status(404).json({ success: false, error: 'Board not found' });
      return;
    }
    res.locals.board = board;
    next();
  }, mcpRouter);

  // ---- Boards API: list, create (admins), members (owners) ----
  const json = express.json({ limit: '16kb' });
  const writeGuard: RequestHandler = (req, res, next) => {
    // Cookie-authenticated writes come only from our own pages (CSRF).
    if (auth && !isSafeMethod(req.method) && !isSameOrigin(auth.authenticator.origin, single(req.headers.origin), single(req.headers.referer))) {
      res.status(403).json({ success: false, error: 'Cross-site request rejected' });
      return;
    }
    next();
  };
  /** The browser session (any board's) of a request; undefined with auth off; false after answering 401. */
  const requireSession: SessionCheck = (req, res) => {
    if (!auth) return undefined;
    const result = auth.authenticator.authenticate({ cookie: single(req.headers.cookie) }, { resource: auth.resource, acceptSession: true, anyBoard: true });
    if (result.ok) return result.principal;
    res.status(401).json({ success: false, error: 'Sign in first' });
    return false;
  };
  app.get('/boards', (req, res) => {
    const principal = requireSession(req, res);
    if (principal === false) return;
    res.setHeader('Cache-Control', 'no-store');
    res.json({ boards: boards.list(principal) });
  });
  app.post('/boards', writeGuard, json, (req, res) => {
    const principal = requireSession(req, res);
    if (principal === false) return;
    const body = (req.body ?? {}) as { id?: unknown; name?: unknown };
    sendOutcome(res, boards.create(principal, body.id, body.name), board => ({ board }), 201);
  });
  app.use(createMembersRouter({ boards, requireSession, writeGuard, json }));

  // ---- Every board's canvas ----
  const signIn = (req: Request, res: Response): void => {
    res.setHeader('Cache-Control', 'no-store');
    if (auth?.signInPath) {
      res.redirect(302, `${auth.signInPath}?return_to=${encodeURIComponent(req.originalUrl)}`);
      return;
    }
    res.status(401).json({ success: false, error: 'Unauthorized' });
  };

  const boardPage = async (res: Response, board: string, principal: Principal | undefined): Promise<void> => {
    const summary = boards.summary(board, principal);
    if (!summary) {
      res.status(404).json({ success: false, error: 'Board not found' });
      return;
    }
    const page = await fetchBoardPage(upstream, board);
    const headers: OutgoingHttpHeaders = { 'content-type': page.type || 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
    framing(headers, 'board');
    res.writeHead(page.status, headers);
    res.end(page.status === 200 ? injectBoardScript(page.body, { id: board, name: summary.name, signOut: Boolean(auth?.signInPath) }) : page.body);
  };

  app.use(async (req: Request, res: Response, next: NextFunction) => {
    if (!isPlainPath(req.path)) {
      res.status(400).json({ success: false, error: 'Bad request path' });
      return;
    }
    const route = parseBoardPath(req.path);
    if (route.kind === 'invalid') {
      res.status(404).json({ success: false, error: 'Board not found' });
      return;
    }
    if (route.prefixed && route.bare) {
      res.redirect(302, `/b/${route.board}/${req.originalUrl.slice(req.path.length)}`);
      return;
    }
    // Upstream's bundle, shared by every board's page (it asks for /assets/... unprefixed).
    const shared = !route.prefixed && /^\/assets\//i.test(route.rest);
    let principal: Principal | undefined;
    if (gate) {
      const verdict = shared
        ? gate.decideShared({ method: req.method, path: route.rest, headers: gateHeaders(req) })
        : gate.decide({ method: req.method, path: route.rest, board: route.board, headers: gateHeaders(req) });
      if (verdict.kind === 'login') return signIn(req, res);
      if (verdict.kind === 'reject') {
        if (verdict.challenge) res.setHeader('WWW-Authenticate', verdict.challenge);
        res.status(verdict.status).json({ success: false, error: verdict.error });
        return;
      }
      principal = verdict.principal;
    }
    if (route.prefixed && route.rest === '/' && (req.method === 'GET' || req.method === 'HEAD')) {
      try {
        await boardPage(res, route.board, principal);
      } catch (error) {
        next(error);
      }
      return;
    }
    forward(req, res, shared ? 'other' : 'board');
  });

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
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    if (!isPlainPath(path)) return rejectUpgrade(socket, 400, 'Bad request path');
    const route = parseBoardPath(path);
    if (route.kind === 'invalid') return rejectUpgrade(socket, 404, 'Board not found');
    let readOnly = false;
    if (gate) {
      const verdict = gate.decideUpgrade(gateHeaders(req), route.board);
      if (!verdict.ok) return rejectUpgrade(socket, verdict.status, verdict.message);
      readOnly = verdict.role === 'viewer';
    }
    proxy.upgrade(req, socket, head, readOnly ? { clientToUpstream: dropDataFrames } : {});
  };

  return { app, onUpgrade };
}
