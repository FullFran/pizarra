import { WHITEBOARD_SCOPE } from '../../domain/scope.js';
import type { AccessTokenVerifier } from '../../application/access-tokens.js';
import type { SessionService } from '../../application/sessions.js';
import type { AuthSettings } from '../../application/settings.js';
import { CookieJar, bearerToken } from './http-helpers.js';
import { resourceMetadataPath } from './oauth-router.js';

/** Who made a request, and with which credential. */
export interface Principal {
  login: string;
  via: 'bearer' | 'session';
  clientId?: string;
  scopes: string[];
  /** Seconds since epoch (bearer only). */
  expiresAt?: number;
  resource?: string;
  token?: string;
}

export type Authentication =
  | { ok: true; principal: Principal }
  | { ok: false; status: 401 | 403; error: 'unauthorized' | 'invalid_token' | 'insufficient_scope'; challenge: string };

export interface CredentialHeaders {
  authorization?: string | undefined;
  cookie?: string | undefined;
}

export interface AuthenticateOptions {
  /** The protected resource (audience) being accessed. */
  resource: string;
  /** Whether the browser session cookie is accepted (when no bearer is sent). */
  acceptSession: boolean;
}

/**
 * "Is this request authenticated, and as whom?" A bearer token, when sent,
 * decides alone; otherwise the session cookie, if accepted. This is the one
 * entry point other modules (the canvas proxy, `/mcp`) use.
 */
export class HttpRequestAuthenticator {
  constructor(
    private readonly settings: AuthSettings,
    private readonly cookies: CookieJar,
    private readonly sessions: SessionService,
    private readonly accessTokens: AccessTokenVerifier
  ) {}

  /** Origin cookie-authenticated writes must come from. */
  get origin(): string {
    return this.settings.issuer;
  }

  private challenge(resource: string, error?: string, description?: string): string {
    const metadata = `${this.settings.issuer}${resourceMetadataPath(this.settings, resource)}`;
    let value = `Bearer resource_metadata="${metadata}", scope="${WHITEBOARD_SCOPE}"`;
    if (error) value += `, error="${error}"`;
    if (description) value += `, error_description="${description}"`;
    return value;
  }

  authenticate(headers: CredentialHeaders, options: AuthenticateOptions): Authentication {
    const token = bearerToken(headers.authorization);
    if (token) {
      const result = this.accessTokens.verify(token, options.resource);
      if (result.ok) {
        const record = result.record;
        return {
          ok: true,
          principal: {
            login: record.login, via: 'bearer', clientId: record.clientId, scopes: record.scope.split(' '),
            expiresAt: record.expiresAt, resource: record.resource, token
          }
        };
      }
      if (result.error === 'insufficient_scope') {
        return { ok: false, status: 403, error: 'insufficient_scope', challenge: this.challenge(options.resource, 'insufficient_scope', 'the whiteboard scope is required') };
      }
      return { ok: false, status: 401, error: 'invalid_token', challenge: this.challenge(options.resource, 'invalid_token', 'the access token is invalid or expired') };
    }
    if (options.acceptSession) {
      const session = this.sessions.read(this.cookies.read(headers.cookie, this.cookies.session));
      if (session) return { ok: true, principal: { login: session.login, via: 'session', scopes: [WHITEBOARD_SCOPE] } };
    }
    return { ok: false, status: 401, error: 'unauthorized', challenge: this.challenge(options.resource) };
  }
}
