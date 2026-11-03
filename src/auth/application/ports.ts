import type { RegisteredClient } from '../domain/client.js';
import type { RefreshTokenRecord, TokenRecord } from '../domain/token.js';

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
}

/** Source of the raw signing secret (explicit, or generated on first start). */
export interface SecretProvider {
  secret(): Buffer;
}

/** Durable store of registered clients and hashed tokens. */
export interface TokenStore {
  clientCount(): number;
  getClient(clientId: string): RegisteredClient | undefined;
  addClient(client: RegisteredClient): void;
  /** Opens a new refresh-token family (one per authorization code grant). */
  createFamily(expiresAt: number): string;
  isFamilyActive(familyId: string): boolean;
  extendFamily(familyId: string, expiresAt: number): void;
  /** Revokes every access and refresh token of a family. */
  revokeFamily(familyId: string): void;
  putTokens(access: { hash: string; record: TokenRecord }, refresh: { hash: string; record: RefreshTokenRecord }): void;
  /** A live access token (not expired, family active), or undefined. */
  getAccessToken(hash: string): TokenRecord | undefined;
  getRefreshToken(hash: string): RefreshTokenRecord | undefined;
  markRefreshTokenUsed(hash: string): void;
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
