import { DEFAULT_BOARD } from '../domain/board-path.js';
import { isApiPath, isSafeMethod, isSameOrigin } from '../domain/request-policy.js';
import type { BoardDirectory, BoardRole, Principal, RequestAuthenticator } from './ports.js';

export interface GateRequest {
  method: string;
  /** Path inside the board's canvas (`/api/...`, `/`, an asset). */
  path: string;
  /** The board the request is for (default: main). */
  board?: string;
  headers: { authorization?: string | undefined; cookie?: string | undefined; origin?: string | undefined; referer?: string | undefined };
}

export type GateVerdict =
  | { kind: 'allow'; principal?: Principal; role?: BoardRole }
  | { kind: 'login' }
  | { kind: 'reject'; status: number; error: string; challenge?: string };

export type UpgradeVerdict =
  | { ok: true; role?: BoardRole }
  | { ok: false; status: 401 | 403 | 404; message: string };

export interface GateOptions {
  /** Acceptable token audiences for a board (the first is its canonical resource). */
  resources: (board: string) => readonly string[];
  /** Who may open which board; without it every authenticated principal opens every board (one canvas). */
  boards?: BoardDirectory;
}

/**
 * Who may reach a board's canvas (UI, static files, REST API, WebSocket)
 * through the proxy:
 * - `/api/*` (any case): a bearer token for the board's resource, or a
 *   session cookie; cookie writes need our Origin (CSRF).
 * - everything else: a session cookie (GET/HEAD without one go to the
 *   sign-in page); any cookie write, whatever the path, needs our Origin.
 * - WebSocket: a bearer token, or a session cookie with our Origin.
 * Then the board decides: no role is a 404 (a board you cannot open looks
 * like one that does not exist), and a viewer cannot write.
 */
export class AccessGate {
  private readonly options: GateOptions;

  constructor(private readonly authenticator: RequestAuthenticator, resource: string | GateOptions) {
    this.options = typeof resource === 'string' ? { resources: () => [resource] } : resource;
  }

  private audience(board: string): string | readonly string[] {
    const resources = this.options.resources(board);
    return resources.length === 1 ? resources[0]! : resources;
  }

  private role(board: string, principal: Principal): BoardRole | undefined | 'none' {
    if (!this.options.boards) return undefined;
    return this.options.boards.summary(board, principal)?.role ?? 'none';
  }

  decide(request: GateRequest): GateVerdict {
    const { method, path, headers } = request;
    const board = request.board ?? DEFAULT_BOARD;
    const resources = this.audience(board);
    const sameOrigin = () => isSameOrigin(this.authenticator.origin, headers.origin, headers.referer);
    let principal: Principal;
    if (isApiPath(path)) {
      const result = this.authenticator.authenticate(headers, { resource: resources, acceptSession: true, board });
      if (!result.ok) return { kind: 'reject', status: result.status, error: 'Unauthorized', challenge: result.challenge };
      if (result.principal.via === 'session' && !isSafeMethod(method) && !sameOrigin()) {
        return { kind: 'reject', status: 403, error: 'Cross-site request rejected' };
      }
      principal = result.principal;
    } else {
      // The canvas page and its assets are for browsers: only a session counts.
      const result = this.authenticator.authenticate({ cookie: headers.cookie }, { resource: resources, acceptSession: true, board });
      if (!result.ok) {
        const upper = method.toUpperCase();
        if (upper === 'GET' || upper === 'HEAD') return { kind: 'login' };
        return { kind: 'reject', status: 401, error: 'Unauthorized' };
      }
      if (!isSafeMethod(method) && !sameOrigin()) return { kind: 'reject', status: 403, error: 'Cross-site request rejected' };
      principal = result.principal;
    }
    const role = this.role(board, principal);
    if (role === 'none') return { kind: 'reject', status: 404, error: 'Board not found' };
    if (role === 'viewer' && !isSafeMethod(method)) return { kind: 'reject', status: 403, error: 'This board is read-only for you' };
    return { kind: 'allow', principal, ...(role ? { role } : {}) };
  }

  /** Files every board's page shares (the upstream bundle): any session will do. */
  decideShared(request: Omit<GateRequest, 'board'>): GateVerdict {
    const result = this.authenticator.authenticate({ cookie: request.headers.cookie }, { resource: this.audience(DEFAULT_BOARD), acceptSession: true, anyBoard: true });
    if (result.ok) {
      if (!isSafeMethod(request.method)) return { kind: 'reject', status: 405, error: 'Method not allowed' };
      return { kind: 'allow', principal: result.principal };
    }
    const upper = request.method.toUpperCase();
    return upper === 'GET' || upper === 'HEAD' ? { kind: 'login' } : { kind: 'reject', status: 401, error: 'Unauthorized' };
  }

  decideUpgrade(headers: GateRequest['headers'], board: string = DEFAULT_BOARD): UpgradeVerdict {
    const origin = headers.origin;
    if (origin !== undefined && origin !== this.authenticator.origin) return { ok: false, status: 403, message: 'Origin not allowed' };
    const result = this.authenticator.authenticate(headers, { resource: this.audience(board), acceptSession: true, board });
    if (!result.ok) return { ok: false, status: 401, message: result.error === 'unauthorized' ? 'Unauthorized' : 'Invalid access token' };
    // A cookie is sent by the browser on any page's behalf: the page must be ours.
    if (result.principal.via === 'session' && origin === undefined) return { ok: false, status: 403, message: 'Origin required' };
    const role = this.role(board, result.principal);
    if (role === 'none') return { ok: false, status: 404, message: 'Board not found' };
    return role ? { ok: true, role } : { ok: true };
  }
}
