import express from 'express';
import type { NextFunction, Request, Response, Router } from 'express';
import type { AgentAllowlist } from './allowlist.js';
import type { AgentHub, HubEvent } from './hub.js';
import { ENGINE_HTTP_STATUS, EngineError } from './manager.js';
import type { AgentManager } from './manager.js';
import { toErrorCode } from './protocol.js';

export type AgentRole = 'owner' | 'editor' | 'viewer';

/** Who asks, as the gateway's access decision for this board left it in `res.locals.agent`. */
export interface AgentContext {
  board: string;
  principal?: { login: string; provider?: string | undefined; issuer?: string | undefined; board?: string | undefined; via: 'bearer' | 'session' };
  role?: AgentRole;
}

export const AGENT_CONTEXT_LOCAL = 'agent';

export interface AgentRouterDeps {
  manager: AgentManager;
  hub: AgentHub;
  allowlist: AgentAllowlist;
  /** The origin of this server as browsers see it; a POST must come from it. */
  origin: string;
  keepaliveMs?: number;
}

const MAX_TEXT = 8000;

const DISABLED_STATUS = { enabled: false, connected: false, busy: false, pending: null };

/**
 * Who may use the agent: a person signed in through GitHub with a browser session (never an
 * issuer's ticket or a bearer), on the allowlist, who may edit this board.
 */
export function mayUseAgent(context: AgentContext, allowlist: AgentAllowlist): context is AgentContext & { principal: NonNullable<AgentContext['principal']> } {
  const { principal, role } = context;
  if (!principal) return false;
  if (principal.provider !== undefined && principal.provider !== 'github') return false;
  if (principal.issuer !== undefined || principal.board !== undefined || principal.via !== 'session') return false;
  if (role !== 'editor' && role !== 'owner') return false;
  return allowlist.has(principal.login);
}

function isJson(req: Request): boolean {
  return /^application\/json\s*(;|$)/i.test(req.headers['content-type'] ?? '');
}

function openStream(res: Response): void {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Tells a buffering reverse proxy to pass each event on as it is written.
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
}

function frame(res: Response, event: string, data: object): void {
  if (res.writableEnded || res.destroyed) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * The agent's HTTP surface for one board, mounted by the gateway after its access decision for
 * `/b/<board>/__agent/*` (and `/__agent/*` for main). Everything but `status` and `events` is for
 * the allowlisted editors only and answers 404 to anyone else.
 */
export function createAgentRouter(deps: AgentRouterDeps): Router {
  const { manager, hub, allowlist } = deps;
  const router = express.Router();
  const context = (res: Response): AgentContext => res.locals[AGENT_CONTEXT_LOCAL] as AgentContext;
  const notFound = (res: Response): void => { res.status(404).json({ error: 'not_found' }); };
  const refuse = (res: Response, code: string, status: number): void => { res.status(status).json({ error: code }); };
  const engineFailure = (res: Response, error: unknown): void => {
    // Only the fixed code leaves the server, never the text of a provider error.
    if (error instanceof EngineError) return refuse(res, error.code, ENGINE_HTTP_STATUS[error.code]);
    refuse(res, 'engine_unavailable', 503);
  };

  router.get('/status', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const ctx = context(res);
    if (!mayUseAgent(ctx, allowlist)) return void res.json(DISABLED_STATUS);
    res.json({ enabled: true, ...manager.status(ctx.principal.login.toLowerCase(), ctx.board) });
  });

  router.get('/events', (req, res) => {
    const ctx = context(res);
    // The hub may replay who is working while subscribing, before the stream is open.
    let open = false;
    const early: HubEvent[] = [];
    const unsubscribe = hub.subscribe(ctx.board, (event: HubEvent) => (open ? frame(res, event.event, event.data) : early.push(event)));
    if (!unsubscribe) return refuse(res, 'busy', 503);
    openStream(res);
    res.write(': ok\n\n');
    open = true;
    for (const event of early) frame(res, event.event, event.data);
    const keepalive = setInterval(() => { if (!res.writableEnded && !res.destroyed) res.write(': keepalive\n\n'); }, deps.keepaliveMs ?? 25_000);
    keepalive.unref();
    res.on('close', () => { clearInterval(keepalive); unsubscribe(); });
  });

  // Everything below is for allowlisted editors; for anyone else it does not exist.
  const POSTS = new Set(['/login', '/logout', '/abort', '/reset', '/prompt']);
  router.use((req, res, next) => {
    if (req.method !== 'POST' || !POSTS.has(req.path) || !mayUseAgent(context(res), allowlist)) return notFound(res);
    // Cookie-authenticated writes come only from our own pages (CSRF).
    if (req.headers.origin !== deps.origin) return refuse(res, 'cross_site', 403);
    if (!isJson(req)) return refuse(res, 'unsupported_media_type', 415);
    next();
  }, express.json({ limit: '64kb', type: () => true }));

  const who = (res: Response): { login: string; board: string } => {
    const ctx = context(res) as AgentContext & { principal: NonNullable<AgentContext['principal']> };
    return { login: ctx.principal.login.toLowerCase(), board: ctx.board };
  };

  router.post('/login', async (req, res) => {
    const { login, board } = who(res);
    try {
      res.json(await manager.startLogin(login, board));
    } catch (error) {
      engineFailure(res, error);
    }
  });

  router.post('/logout', (req, res) => {
    manager.disconnect(who(res).login);
    res.status(204).end();
  });

  router.post('/abort', (req, res) => {
    const { login, board } = who(res);
    manager.abort(login, board);
    res.status(204).end();
  });

  router.post('/reset', async (req, res) => {
    const { login, board } = who(res);
    try {
      await manager.reset(login, board);
      res.status(204).end();
    } catch (error) {
      engineFailure(res, error);
    }
  });

  router.post('/prompt', async (req, res) => {
    const { login, board } = who(res);
    const body = req.body as { text?: unknown } | null;
    const text = typeof body === 'object' && body !== null ? body.text : undefined;
    if (typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT) return refuse(res, 'invalid_text', 400);
    let turn: Promise<void>;
    let streaming = false;
    let finished = false;
    try {
      turn = manager.prompt(login, board, text, {
        event: (name, data) => {
          if (!streaming) return;
          frame(res, name, name === 'error' ? { code: toErrorCode((data as { code?: unknown }).code) } : data);
        }
      });
    } catch (error) {
      return engineFailure(res, error);
    }
    streaming = true;
    openStream(res);
    res.on('close', () => { if (!finished) manager.abort(login, board); });
    await turn;
    finished = true;
    res.end();
  });

  router.use((req, res) => notFound(res));
  router.use((err: Error, req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    // A body that is not JSON or is too large: a fixed code, never the parser's text.
    const status = (err as { status?: unknown }).status;
    refuse(res, 'invalid_request', typeof status === 'number' && status >= 400 && status < 500 ? status : 400);
  });
  return router;
}
