import { WHITEBOARD_SCOPE } from '../domain/scope.js';
import type { AccessTokenVerifier } from './access-tokens.js';
import type { IdentityProvider, ProviderAnswer, Target } from './identity.js';
import type { SessionService } from './sessions.js';

export const GITHUB_PROVIDER = 'github';

/**
 * The default way in: people sign in with GitHub (device flow) and get a
 * session cookie; their agents get OAuth 2.1 access tokens from this
 * server's authorization server, bound to one resource (a board's MCP).
 */
export class GitHubProvider implements IdentityProvider {
  readonly id = GITHUB_PROVIDER;

  constructor(private readonly sessions: SessionService, private readonly tokens: AccessTokenVerifier, private readonly sessionCookie: string) {}

  bearer(token: string, target: Target): ProviderAnswer {
    const result = this.tokens.verify(token, target.resources);
    if (!result.ok) return { kind: 'invalid', error: result.error === 'insufficient_scope' ? 'insufficient_scope' : 'invalid_token' };
    const record = result.record;
    return {
      kind: 'ok',
      identity: {
        provider: this.id, subject: record.login, via: 'bearer', clientId: record.clientId, scopes: record.scope.split(' '),
        expiresAt: record.expiresAt, resource: record.resource, token
      }
    };
  }

  session(cookies: ReadonlyMap<string, string>): ProviderAnswer {
    const session = this.sessions.read(cookies.get(this.sessionCookie));
    if (!session) return { kind: 'none' };
    return { kind: 'ok', identity: { provider: this.id, subject: session.login, via: 'session', scopes: [WHITEBOARD_SCOPE] } };
  }

  sessionCookieNames(cookies: ReadonlyMap<string, string>): string[] {
    return cookies.has(this.sessionCookie) ? [this.sessionCookie] : [];
  }
}
