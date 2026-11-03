import { ClientError } from '../domain/client.js';
import type { ResolvedClient } from '../domain/client.js';
import { pkceS256Matches } from '../domain/pkce.js';
import { chooseResource } from '../domain/resource.js';
import { withinGrant } from '../domain/scope.js';
import type { RefreshTokenRecord, TokenRecord } from '../domain/token.js';
import type { AuthorizationCodes } from './authorization-codes.js';
import type { ClientRegistry } from './clients.js';
import type { AuthSettings } from './settings.js';
import type { Clock, Hasher, Logger, RandomSource, TokenStore } from './ports.js';
import { nowSeconds } from './ports.js';

export interface ClientCredentials {
  clientId: string | undefined;
  clientSecret: string | undefined;
  /** Credentials came from HTTP Basic (errors then carry `WWW-Authenticate: Basic`). */
  usedBasic: boolean;
}

export interface TokenRequest {
  grantType: string | undefined;
  code: string | undefined;
  redirectUri: string | undefined;
  codeVerifier: string | undefined;
  refreshToken: string | undefined;
  scope: string | undefined;
  resource: unknown;
}

export type TokenResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; status: number; error: string; description: string; basicChallenge?: boolean };

/** The token endpoint: authorization_code and rotating refresh_token grants. */
export class TokenService {
  constructor(
    private readonly settings: AuthSettings,
    private readonly store: TokenStore,
    private readonly clients: ClientRegistry,
    private readonly codes: AuthorizationCodes,
    private readonly hasher: Hasher,
    private readonly random: RandomSource,
    private readonly clock: Clock,
    private readonly logger: Logger
  ) {}

  async exchange(credentials: ClientCredentials, request: TokenRequest): Promise<TokenResult> {
    const fail = (status: number, error: string, description: string, basicChallenge = false): TokenResult =>
      ({ ok: false, status, error, description, ...(basicChallenge ? { basicChallenge } : {}) });
    let client: ResolvedClient;
    try {
      client = await this.clients.resolve(credentials.clientId);
    } catch (error) {
      if (error instanceof ClientError) return fail(401, 'invalid_client', error.message, credentials.usedBasic);
      throw error;
    }
    if (!this.clients.authenticate(client, credentials.clientSecret)) {
      return fail(401, 'invalid_client', 'client authentication failed', credentials.usedBasic);
    }
    if (request.resource !== undefined && !chooseResource(request.resource, this.settings.resources).ok) {
      return fail(400, 'invalid_target', `resource must be one of ${this.settings.resources.join(', ')}`);
    }

    if (request.grantType === 'authorization_code') {
      // Single use: burnt on first presentation, whatever the outcome, atomically across gateways.
      const record = this.codes.redeem(request.code, client.clientId);
      if (!record) return fail(400, 'invalid_grant', 'unknown authorization code');
      if (record.used) {
        // RFC 6749 §4.1.2: a replayed code revokes what it issued.
        if (record.familyId) this.store.revokeFamily(record.familyId);
        this.logger.warn('Authorization code replayed; revoked its tokens', { clientId: client.clientId });
        return fail(400, 'invalid_grant', 'authorization code already used');
      }
      if (record.expiresAt <= nowSeconds(this.clock)) return fail(400, 'invalid_grant', 'authorization code expired');
      if (request.redirectUri !== record.redirectUri) return fail(400, 'invalid_grant', 'redirect_uri does not match the authorization request');
      if (request.resource !== undefined && chooseResource(request.resource, [record.resource]).ok === false) {
        return fail(400, 'invalid_target', 'resource does not match the authorization request');
      }
      const verifier = request.codeVerifier;
      if (!verifier || !pkceS256Matches(verifier, record.codeChallenge, v => this.hasher.sha256Base64Url(v), (a, b) => this.hasher.constantTimeEqual(a, b))) {
        return fail(400, 'invalid_grant', 'PKCE verification failed');
      }
      const familyId = this.store.createFamily(nowSeconds(this.clock) + this.settings.refreshTokenTtlSeconds);
      this.codes.issued(request.code!, familyId);
      return { ok: true, body: this.issue(client.clientId, record.login, record.scope, record.resource, familyId) };
    }

    if (request.grantType === 'refresh_token') {
      const hash = request.refreshToken ? this.hasher.sha256Hex(request.refreshToken) : undefined;
      const record = hash ? this.store.getRefreshToken(hash) : undefined;
      if (!hash || !record || record.clientId !== client.clientId) return fail(400, 'invalid_grant', 'unknown refresh token');
      if (record.usedAt !== undefined) {
        // Rotation: a refresh token is valid once. Reuse means it leaked.
        this.store.revokeFamily(record.familyId);
        this.logger.warn('Refresh token reused; revoked its token family', { clientId: client.clientId });
        return fail(400, 'invalid_grant', 'refresh token already used');
      }
      if (!this.store.isFamilyActive(record.familyId)) return fail(400, 'invalid_grant', 'refresh token revoked');
      if (!this.settings.allowedLogins.has(record.login)) return fail(400, 'invalid_grant', 'account no longer allowed');
      if (!withinGrant(request.scope, record.scope)) return fail(400, 'invalid_scope', 'scope exceeds the original grant');
      if (!this.store.markRefreshTokenUsed(hash)) {
        // Another exchange (maybe on the other gateway) won the race: same as reuse.
        this.store.revokeFamily(record.familyId);
        this.logger.warn('Refresh token reused; revoked its token family', { clientId: client.clientId });
        return fail(400, 'invalid_grant', 'refresh token already used');
      }
      return { ok: true, body: this.issue(client.clientId, record.login, record.scope, record.resource, record.familyId) };
    }
    return fail(400, 'unsupported_grant_type', 'grant_type must be authorization_code or refresh_token');
  }

  private issue(clientId: string, login: string, scope: string, resource: string, familyId: string): Record<string, unknown> {
    const accessToken = this.random.token(32);
    const refreshToken = this.random.token(32);
    const now = nowSeconds(this.clock);
    const accessRecord: TokenRecord = { clientId, login, scope, resource, familyId, expiresAt: now + this.settings.accessTokenTtlSeconds };
    const refreshRecord: RefreshTokenRecord = { clientId, login, scope, resource, familyId, expiresAt: now + this.settings.refreshTokenTtlSeconds };
    this.store.extendFamily(familyId, refreshRecord.expiresAt);
    this.store.putTokens(
      { hash: this.hasher.sha256Hex(accessToken), record: accessRecord },
      { hash: this.hasher.sha256Hex(refreshToken), record: refreshRecord }
    );
    return { access_token: accessToken, token_type: 'Bearer', expires_in: this.settings.accessTokenTtlSeconds, refresh_token: refreshToken, scope };
  }
}
