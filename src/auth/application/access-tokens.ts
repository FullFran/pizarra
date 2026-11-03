import { WHITEBOARD_SCOPE } from '../domain/scope.js';
import type { TokenRecord } from '../domain/token.js';
import type { AuthSettings } from './settings.js';
import type { Hasher, TokenStore } from './ports.js';

export type AccessTokenCheck =
  | { ok: true; record: TokenRecord }
  | { ok: false; error: 'missing' | 'invalid_token' | 'insufficient_scope' };

/** Resource-server check of an opaque bearer token for one protected resource. */
export class AccessTokenVerifier {
  constructor(private readonly settings: AuthSettings, private readonly store: TokenStore, private readonly hasher: Hasher) {}

  verify(token: string | undefined, resource: string): AccessTokenCheck {
    if (!token) return { ok: false, error: 'missing' };
    const record = this.store.getAccessToken(this.hasher.sha256Hex(token));
    // Audience check: the token must have been issued for this resource.
    if (!record || record.resource !== resource || !this.settings.resources.includes(resource) || !this.settings.allowedLogins.has(record.login)) {
      return { ok: false, error: 'invalid_token' };
    }
    if (!record.scope.split(' ').includes(WHITEBOARD_SCOPE)) return { ok: false, error: 'insufficient_scope' };
    return { ok: true, record };
  }
}
