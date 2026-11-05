import type { Identity, IdentityProvider, Target } from '../../application/identity.js';
import { bearerToken, parseCookies } from './http-helpers.js';

/** Who made a request, and with which credential. */
export interface Principal extends Identity {
  /** The subject, as the gateway logs and shows it (a GitHub login, an issuer's `sub`). */
  login: string;
}

export type Authentication =
  | { ok: true; principal: Principal }
  | { ok: false; status: 401 | 403; error: 'unauthorized' | 'invalid_token' | 'insufficient_scope'; challenge: string };

export interface CredentialHeaders {
  authorization?: string | undefined;
  cookie?: string | undefined;
}

export interface AuthenticateOptions {
  /** The protected resource (audience) being accessed, or several acceptable ones (the first is canonical). */
  resource: string | readonly string[];
  /** Whether a browser session cookie is accepted (when no bearer is sent). */
  acceptSession: boolean;
  /** The board the request is for (board-scoped credentials only open this one). */
  board?: string;
  /** Any board's session will do (static files shared by every board). */
  anyBoard?: boolean;
}

/** `WWW-Authenticate` value for a resource (OAuth discovery when the GitHub provider is on). */
export type ChallengeBuilder = (resource: string, error?: string, description?: string) => string;

/**
 * "Is this request authenticated, and as whom?" A bearer token, when sent,
 * decides alone; otherwise a session cookie, if accepted. Each enabled
 * identity provider is asked in turn; the first that vouches wins. This is
 * the one entry point other modules (the canvas proxy, `/mcp`) use.
 */
export class HttpRequestAuthenticator {
  constructor(
    private readonly providers: readonly IdentityProvider[],
    /** Origin cookie-authenticated writes must come from. */
    readonly origin: string,
    private readonly challenge: ChallengeBuilder
  ) {}

  /** Lets providers fetch what the synchronous check will need (e.g. a key for this bearer). */
  async prepare(headers: CredentialHeaders): Promise<void> {
    const token = bearerToken(headers.authorization);
    await Promise.all(this.providers.map(provider => provider.prepare?.(token)));
  }

  /** Names of every provider's session cookies present in `cookieHeader`. */
  sessionCookieNames(cookieHeader: string | undefined): string[] {
    const cookies = parseCookies(cookieHeader);
    return this.providers.flatMap(provider => provider.sessionCookieNames?.(cookies) ?? []);
  }

  authenticate(headers: CredentialHeaders, options: AuthenticateOptions): Authentication {
    const resources = typeof options.resource === 'string' ? [options.resource] : [...options.resource];
    const canonical = resources[0] ?? this.origin;
    const target: Target = {
      resources,
      ...(options.board !== undefined ? { board: options.board } : {}),
      ...(options.anyBoard ? { anyBoard: true } : {})
    };
    const token = bearerToken(headers.authorization);
    if (token) {
      let insufficient = false;
      for (const provider of this.providers) {
        const answer = provider.bearer?.(token, target) ?? { kind: 'none' };
        if (answer.kind === 'ok') return { ok: true, principal: { ...answer.identity, login: answer.identity.subject } };
        if (answer.kind === 'invalid' && answer.error === 'insufficient_scope') insufficient = true;
      }
      if (insufficient) {
        return { ok: false, status: 403, error: 'insufficient_scope', challenge: this.challenge(canonical, 'insufficient_scope', 'the whiteboard scope is required') };
      }
      return { ok: false, status: 401, error: 'invalid_token', challenge: this.challenge(canonical, 'invalid_token', 'the access token is invalid or expired') };
    }
    if (options.acceptSession) {
      const cookies = parseCookies(headers.cookie);
      for (const provider of this.providers) {
        const answer = provider.session?.(cookies, target) ?? { kind: 'none' };
        if (answer.kind === 'ok') return { ok: true, principal: { ...answer.identity, login: answer.identity.subject } };
      }
    }
    return { ok: false, status: 401, error: 'unauthorized', challenge: this.challenge(canonical) };
  }
}
