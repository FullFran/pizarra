import type { Allowlist } from '../domain/allowlist.js';

/** What the auth use cases need to know about this deployment. */
export interface AuthSettings {
  /** Authorization server issuer and public origin, e.g. `https://board.example.com`. */
  issuer: string;
  /** Protected resources (audiences) tokens may be issued for; today `${issuer}/mcp`. */
  resources: string[];
  allowedLogins: Allowlist;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  sessionTtlSeconds: number;
  authorizationCodeTtlSeconds: number;
}
