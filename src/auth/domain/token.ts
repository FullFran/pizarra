import type { DeviceOutcome } from './device-login.js';

export interface TokenRecord {
  clientId: string;
  login: string;
  scope: string;
  /** Protected resource (audience) the token was issued for. */
  resource: string;
  /** Seconds since epoch. */
  expiresAt: number;
  familyId: string;
}

export interface RefreshTokenRecord extends TokenRecord {
  /** Set once the token has been exchanged; a second exchange revokes the family. */
  usedAt?: number;
}

/** An authorization code (in the shared store, by hash; single use). */
export interface CodeRecord {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  resource: string;
  login: string;
  expiresAt: number;
  used: boolean;
  familyId?: string;
}

/**
 * A GitHub device login waiting for its browser, in the shared store (epoch
 * milliseconds). GitHub's secret device code is not here: it travels sealed
 * in the browser's binding cookie, so it is never written to disk.
 */
export interface DeviceLoginRecord {
  userCode: string;
  verificationUri: string;
  expiresAt: number;
  intervalMs: number;
  nextPollAt: number;
  returnTo: string;
  outcome?: DeviceOutcome;
}
