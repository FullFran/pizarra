import { isApiPath, isSafeMethod, isSameOrigin } from '../domain/request-policy.js';
import type { RequestAuthenticator } from './ports.js';

export interface GateRequest {
  method: string;
  path: string;
  headers: { authorization?: string | undefined; cookie?: string | undefined; origin?: string | undefined; referer?: string | undefined };
}

export type GateVerdict =
  | { kind: 'allow' }
  | { kind: 'login' }
  | { kind: 'reject'; status: number; error: string; challenge?: string };

export type UpgradeVerdict = { ok: true } | { ok: false; status: 401 | 403; message: string };

/**
 * Who may reach the canvas (UI, static files, REST API, WebSocket) through
 * the proxy:
 * - `/api/*` (any case): a bearer token for the board resource, or the
 *   session cookie; cookie writes need our Origin (CSRF).
 * - everything else: the session cookie (GET/HEAD without one go to the
 *   sign-in page); any cookie write, whatever the path, needs our Origin.
 * - WebSocket: a bearer token, or the session cookie with our Origin.
 */
export class AccessGate {
  constructor(private readonly authenticator: RequestAuthenticator, private readonly resource: string) {}

  decide(request: GateRequest): GateVerdict {
    const { method, path, headers } = request;
    const sameOrigin = () => isSameOrigin(this.authenticator.origin, headers.origin, headers.referer);
    if (isApiPath(path)) {
      const result = this.authenticator.authenticate(headers, { resource: this.resource, acceptSession: true });
      if (!result.ok) return { kind: 'reject', status: result.status, error: 'Unauthorized', challenge: result.challenge };
      if (result.principal.via === 'session' && !isSafeMethod(method) && !sameOrigin()) {
        return { kind: 'reject', status: 403, error: 'Cross-site request rejected' };
      }
      return { kind: 'allow' };
    }
    // The canvas page and its assets are for browsers: only the session counts.
    const result = this.authenticator.authenticate({ cookie: headers.cookie }, { resource: this.resource, acceptSession: true });
    if (result.ok) {
      if (!isSafeMethod(method) && !sameOrigin()) return { kind: 'reject', status: 403, error: 'Cross-site request rejected' };
      return { kind: 'allow' };
    }
    const upper = method.toUpperCase();
    if (upper === 'GET' || upper === 'HEAD') return { kind: 'login' };
    return { kind: 'reject', status: 401, error: 'Unauthorized' };
  }

  decideUpgrade(headers: GateRequest['headers']): UpgradeVerdict {
    const origin = headers.origin;
    if (origin !== undefined && origin !== this.authenticator.origin) return { ok: false, status: 403, message: 'Origin not allowed' };
    const result = this.authenticator.authenticate(headers, { resource: this.resource, acceptSession: true });
    if (!result.ok) return { ok: false, status: 401, message: result.error === 'unauthorized' ? 'Unauthorized' : 'Invalid access token' };
    // A cookie is sent by the browser on any page's behalf: the page must be ours.
    if (result.principal.via === 'session' && origin === undefined) return { ok: false, status: 403, message: 'Origin required' };
    return { ok: true };
  }
}
