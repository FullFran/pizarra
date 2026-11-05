/** Signature algorithms a trusted issuer may use: asymmetric only, so pizarra never holds a signing key. */
export const TICKET_ALGORITHMS = ['EdDSA', 'ES256'] as const;
export type TicketAlgorithm = (typeof TICKET_ALGORITHMS)[number];

export function isTicketAlgorithm(value: unknown): value is TicketAlgorithm {
  return value === 'EdDSA' || value === 'ES256';
}

/** A ticket lives at most this long (`exp`), seconds. */
export const MAX_TICKET_LIFETIME_SECONDS = 300;
/** Tolerated clock difference with the issuer, seconds. */
export const CLOCK_SKEW_SECONDS = 30;

const BOARD_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

export interface TicketClaims {
  iss: string;
  sub: string;
  name?: string;
  board: string;
  role: 'editor' | 'viewer';
  jti: string;
  exp: number;
}

export type ClaimsCheck = { ok: true; claims: TicketClaims } | { ok: false; reason: string };

function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
}

/**
 * The claims of a signed board ticket (its signature already checked):
 * `iss` the expected issuer, `aud` this pizarra, an opaque `sub`, an
 * optional display `name`, the `board` and the `role` (`editor` or
 * `viewer`), a `jti`, and an `exp` at most five minutes ahead.
 */
export function checkTicketClaims(payload: unknown, expected: { issuer: string; audience: string; now: number }): ClaimsCheck {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { ok: false, reason: 'claims are not an object' };
  const claims = payload as Record<string, unknown>;
  if (claims.iss !== expected.issuer) return { ok: false, reason: 'wrong issuer' };
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(expected.audience)) return { ok: false, reason: 'wrong audience' };
  if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp)) return { ok: false, reason: 'no expiry' };
  if (claims.exp <= expected.now) return { ok: false, reason: 'expired' };
  if (claims.exp > expected.now + MAX_TICKET_LIFETIME_SECONDS + CLOCK_SKEW_SECONDS) return { ok: false, reason: 'lives longer than five minutes' };
  if (claims.iat !== undefined) {
    if (typeof claims.iat !== 'number' || claims.iat > expected.now + CLOCK_SKEW_SECONDS) return { ok: false, reason: 'issued in the future' };
    if (claims.exp - claims.iat > MAX_TICKET_LIFETIME_SECONDS) return { ok: false, reason: 'lives longer than five minutes' };
  }
  if (claims.nbf !== undefined && (typeof claims.nbf !== 'number' || claims.nbf > expected.now + CLOCK_SKEW_SECONDS)) return { ok: false, reason: 'not valid yet' };
  if (!text(claims.sub, 256)) return { ok: false, reason: 'no subject' };
  if (claims.name !== undefined && !text(claims.name, 200)) return { ok: false, reason: 'bad name' };
  if (typeof claims.board !== 'string' || !BOARD_ID.test(claims.board)) return { ok: false, reason: 'bad board' };
  if (claims.role !== 'editor' && claims.role !== 'viewer') return { ok: false, reason: 'bad role' };
  if (!text(claims.jti, 256)) return { ok: false, reason: 'no jti' };
  return {
    ok: true,
    claims: {
      iss: claims.iss, sub: claims.sub, ...(claims.name !== undefined ? { name: claims.name as string } : {}),
      board: claims.board, role: claims.role, jti: claims.jti, exp: claims.exp
    }
  };
}
