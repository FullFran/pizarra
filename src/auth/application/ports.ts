import type { RegisteredClient } from '../domain/client.js';
import type { CodeRecord, DeviceLoginRecord, RefreshTokenRecord, TokenRecord } from '../domain/token.js';

export type { Logger } from '../../shared/logger.js';

export interface Clock {
  /** Milliseconds since epoch. */
  nowMs(): number;
}

export function nowSeconds(clock: Clock): number {
  return Math.floor(clock.nowMs() / 1000);
}

export interface RandomSource {
  /** Opaque CSPRNG token, base64url, of `bytes` random bytes (default 32). */
  token(bytes?: number): string;
}

export interface Hasher {
  /** Only this hash of a token or secret is ever stored. */
  sha256Hex(value: string): string;
  sha256Base64Url(value: string): string;
  constantTimeEqual(a: string, b: string): boolean;
}

/** HMAC-signed, expiring values; a value signed for one purpose never verifies as another. */
export interface TicketSigner {
  sign(purpose: string, payload: Record<string, unknown>, ttlSeconds: number): string;
  verify<T extends Record<string, unknown>>(purpose: string, value: string | undefined): (T & { exp: number }) | null;
  /** Like `sign`, but encrypted too: whoever holds the value cannot read the payload. */
  seal(purpose: string, payload: Record<string, unknown>, ttlSeconds: number): string;
  open<T extends Record<string, unknown>>(purpose: string, value: string | undefined): (T & { exp: number }) | null;
}

/** Source of the raw signing secret (explicit, or generated on first start). */
export interface SecretProvider {
  secret(): Buffer;
}

/**
 * Durable store of registered clients, hashed tokens and every other piece of
 * auth state gateways must share (two copies run at once during a deploy).
 * Each change is atomic across processes; single-use operations decide inside it.
 */
export interface TokenStore {
  clientCount(): number;
  getClient(clientId: string): RegisteredClient | undefined;
  addClient(client: RegisteredClient): void;
  /** Opens a refresh-token family (one per authorization code grant); a family already revoked stays revoked. */
  createFamily(expiresAt: number, id?: string): string;
  isFamilyActive(familyId: string): boolean;
  extendFamily(familyId: string, expiresAt: number): void;
  /** Revokes every access and refresh token of a family, even one not created yet. */
  revokeFamily(familyId: string): void;
  putTokens(access: { hash: string; record: TokenRecord }, refresh: { hash: string; record: RefreshTokenRecord }): void;
  /** A live access token (not expired, family active), or undefined. */
  getAccessToken(hash: string): TokenRecord | undefined;
  getRefreshToken(hash: string): RefreshTokenRecord | undefined;
  /** Marks a refresh token used; false when it was already used (or is unknown), so only one exchange wins. */
  markRefreshTokenUsed(hash: string): boolean;
  putCode(hash: string, record: CodeRecord): void;
  /**
   * Burns the code for this client and returns it as it was before (undefined
   * if unknown or another client's). The first burn also fixes the code's
   * token family (`familyId`), so a replay can revoke it.
   */
  useCode(hash: string, clientId: string): CodeRecord | undefined;
  /** True the first time `key` is claimed, false afterwards (until `expiresAt`, seconds). */
  claimOnce(key: string, expiresAt: number): boolean;
  deviceLoginCount(): number;
  getDeviceLogin(nonce: string): DeviceLoginRecord | undefined;
  putDeviceLogin(nonce: string, record: DeviceLoginRecord): void;
  /** Atomically replaces a live device login with `change(record)`; undefined from `change` (or no login) changes nothing. */
  updateDeviceLogin(nonce: string, change: (record: DeviceLoginRecord) => DeviceLoginRecord | undefined): DeviceLoginRecord | undefined;
  deleteDeviceLogin(nonce: string): void;
}

export class MetadataFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MetadataFetchError';
  }
}

/** Fetches a Client ID Metadata Document without reaching internal addresses. */
export interface ClientMetadataFetcher {
  /** Throws `MetadataFetchError` when the document cannot be fetched safely. */
  fetch(url: string): Promise<{ status: number; cacheControl?: string; body: string }>;
}

export class IdentityUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdentityUnavailableError';
  }
}

export interface DeviceCode {
  /** Secret handle used to poll; kept server-side only. */
  deviceCode: string;
  /** Short code the person types on GitHub. */
  userCode: string;
  verificationUri: string;
  expiresInSeconds: number;
  intervalSeconds: number;
}

export type DevicePollResult =
  | { kind: 'pending' }
  | { kind: 'slow_down'; intervalSeconds?: number }
  | { kind: 'expired' }
  | { kind: 'denied' }
  | { kind: 'error'; code: string }
  | { kind: 'login'; login: string };

/** GitHub sign-in through the OAuth device flow. */
export interface GitHubIdentity {
  /** Throws `IdentityUnavailableError` when GitHub does not start the flow. */
  requestDeviceCode(): Promise<DeviceCode>;
  /** Throws `IdentityUnavailableError` only when GitHub was unreachable (retry later). */
  pollDeviceLogin(deviceCode: string): Promise<DevicePollResult>;
}
