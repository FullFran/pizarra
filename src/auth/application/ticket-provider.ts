import { checkTicketClaims } from '../domain/signed-ticket.js';
import type { TicketClaims } from '../domain/signed-ticket.js';
import type { Identity, IdentityProvider, ProviderAnswer, Target } from './identity.js';
import type { Clock, TicketSigner, TokenStore } from './ports.js';
import { nowSeconds } from './ports.js';

export const TRUSTED_ISSUER_PROVIDER = 'trusted-issuer';
const BOARD_SESSION_PURPOSE = 'board-session';

export type SignedToken = { ok: true; issuer: string; payload: unknown } | { ok: false; reason: string };

/** Checks a compact JWS against the trusted issuers' public keys. */
export interface TicketVerifier {
  looksLikeTicket(token: string): boolean;
  verify(token: string): SignedToken;
  prepare(token: string | undefined): Promise<void>;
}

/** Whether an issuer's ticket opens a board (an issuer board is created on its first ticket). */
export interface IssuerAdmission {
  admitIssuer(issuer: string, board: string): boolean;
}

export type EnterResult =
  | { ok: true; board: string; cookie: { name: string; value: string; maxAgeSeconds: number } }
  | { ok: false; status: 400 | 401 | 403; reason: string };

interface BoardSession {
  iss: string;
  sub: string;
  name?: string;
  board: string;
  role: 'editor' | 'viewer';
}

/**
 * Adapter (b): signed board tickets from a trusted issuer (Hagalink
 * Projects first). The issuer signs a short ticket (at most five minutes)
 * for one person, one board and one role. A browser trades it once, at
 * `/b/<id>/enter`, for a session cookie for that board only; an agent sends
 * it as a bearer to that board until it expires. pizarra never sees the
 * issuer's own session token.
 */
export class TrustedIssuerProvider implements IdentityProvider {
  readonly id = TRUSTED_ISSUER_PROVIDER;

  constructor(
    private readonly verifier: TicketVerifier,
    private readonly admission: IssuerAdmission,
    private readonly store: TokenStore,
    private readonly signer: TicketSigner,
    private readonly clock: Clock,
    private readonly audience: string,
    /** Cookie name of a board's session (`__Host-` prefixed on https). */
    private readonly cookieName: (board: string) => string,
    private readonly cookiePrefix: string,
    private readonly sessionTtlSeconds: number
  ) {}

  /** A verified ticket's claims, or why not. */
  private claims(token: string): { ok: true; claims: TicketClaims } | { ok: false; reason: string } {
    const signed = this.verifier.verify(token);
    if (!signed.ok) return signed;
    return checkTicketClaims(signed.payload, { issuer: signed.issuer, audience: this.audience, now: nowSeconds(this.clock) });
  }

  private identity(claims: BoardSession, via: 'bearer' | 'session', token?: string, expiresAt?: number): Identity {
    return {
      provider: this.id, subject: claims.sub, ...(claims.name ? { name: claims.name } : {}), issuer: claims.iss,
      role: claims.role, board: claims.board, via, scopes: ['whiteboard'],
      ...(token ? { token } : {}), ...(expiresAt !== undefined ? { expiresAt } : {})
    };
  }

  bearer(token: string, target: Target): ProviderAnswer {
    if (!this.verifier.looksLikeTicket(token)) return { kind: 'none' };
    const checked = this.claims(token);
    if (!checked.ok) return { kind: 'invalid', error: 'invalid_token' };
    const { claims } = checked;
    // A ticket opens its own board only.
    if (target.board === undefined || claims.board !== target.board) return { kind: 'invalid', error: 'invalid_token' };
    if (!this.admission.admitIssuer(claims.iss, claims.board)) return { kind: 'invalid', error: 'invalid_token' };
    return { kind: 'ok', identity: this.identity(claims, 'bearer', token, claims.exp) };
  }

  private readSession(value: string | undefined, board: string): BoardSession | undefined {
    const session = this.signer.verify<BoardSession & Record<string, unknown>>(BOARD_SESSION_PURPOSE, value);
    if (!session || session.board !== board || typeof session.iss !== 'string' || typeof session.sub !== 'string') return undefined;
    if (session.role !== 'editor' && session.role !== 'viewer') return undefined;
    return session;
  }

  session(cookies: ReadonlyMap<string, string>, target: Target): ProviderAnswer {
    if (target.board !== undefined) {
      const session = this.readSession(cookies.get(this.cookieName(target.board)), target.board);
      return session ? { kind: 'ok', identity: this.identity(session, 'session') } : { kind: 'none' };
    }
    if (target.anyBoard) {
      for (const [name, value] of cookies) {
        if (!name.startsWith(this.cookiePrefix)) continue;
        const board = name.slice(this.cookiePrefix.length);
        const session = this.readSession(value, board);
        if (session) return { kind: 'ok', identity: this.identity(session, 'session') };
      }
    }
    return { kind: 'none' };
  }

  prepare(bearer: string | undefined): Promise<void> {
    return this.verifier.prepare(bearer);
  }

  sessionCookieNames(cookies: ReadonlyMap<string, string>): string[] {
    return [...cookies.keys()].filter(name => name.startsWith(this.cookiePrefix));
  }

  /**
   * `GET /b/<board>/enter?ticket=…`: a valid ticket for this board, used for
   * the first time, becomes a session cookie for this board only.
   */
  async enter(ticket: string | undefined, board: string): Promise<EnterResult> {
    if (!ticket) return { ok: false, status: 400, reason: 'missing ticket' };
    await this.verifier.prepare(ticket);
    const checked = this.claims(ticket);
    if (!checked.ok) return { ok: false, status: 401, reason: checked.reason };
    const { claims } = checked;
    if (claims.board !== board) return { ok: false, status: 403, reason: 'ticket for another board' };
    // Single use, decided in the shared store: across gateways only one entry wins.
    if (!this.store.claimOnce(`ticket:${claims.iss}:${claims.jti}`, claims.exp + 60)) return { ok: false, status: 401, reason: 'ticket already used' };
    if (!this.admission.admitIssuer(claims.iss, board)) return { ok: false, status: 403, reason: 'board owned by someone else' };
    const session: BoardSession = { iss: claims.iss, sub: claims.sub, ...(claims.name ? { name: claims.name } : {}), board, role: claims.role };
    return {
      ok: true,
      board,
      cookie: { name: this.cookieName(board), value: this.signer.sign(BOARD_SESSION_PURPOSE, { ...session }, this.sessionTtlSeconds), maxAgeSeconds: this.sessionTtlSeconds }
    };
  }
}
