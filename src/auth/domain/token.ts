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

/** An authorization code (kept in memory, single use). */
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
