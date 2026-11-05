import { createPublicKey, verify as verifySignature } from 'node:crypto';
import type { JsonWebKey, KeyObject } from 'node:crypto';
import { isTicketAlgorithm } from '../domain/signed-ticket.js';
import type { TicketAlgorithm } from '../domain/signed-ticket.js';
import type { Logger } from '../application/ports.js';
import type { SignedToken, TicketVerifier } from '../application/ticket-provider.js';

/** One trusted issuer from `TRUSTED_ISSUERS`. */
export interface TrustedIssuerConfig {
  /** Its `iss` claim. */
  issuer: string;
  alg: TicketAlgorithm;
  /** Where its public keys are published (JWKS), or… */
  jwksUrl?: string;
  /** …its public keys, pinned (JWK). */
  keys?: JsonWebKey[];
}

interface Key {
  kid?: string;
  key: KeyObject;
}

const JWKS_MAX_BYTES = 64 * 1024;
const JWKS_TIMEOUT_MS = 5000;
/** Published keys are re-read this often… */
const JWKS_TTL_MS = 10 * 60_000;
/** …and at most this often when a ticket names a key not seen yet (rotation). */
const JWKS_MIN_INTERVAL_MS = 30_000;

/** A public key for `alg`, or an error: never a private key, never another key type. */
export function importPublicKey(jwk: JsonWebKey, alg: TicketAlgorithm): KeyObject {
  if (!jwk || typeof jwk !== 'object') throw new Error('a key must be a JWK object');
  if ('d' in jwk || 'k' in jwk) throw new Error('a key must be public (no "d" or "k")');
  if (alg === 'EdDSA' && (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519')) throw new Error('EdDSA needs an OKP Ed25519 key');
  if (alg === 'ES256' && (jwk.kty !== 'EC' || jwk.crv !== 'P-256')) throw new Error('ES256 needs an EC P-256 key');
  if (jwk.alg !== undefined && jwk.alg !== alg) throw new Error(`key alg ${String(jwk.alg)} does not match ${alg}`);
  if (jwk.use !== undefined && jwk.use !== 'sig') throw new Error('key use must be "sig"');
  return createPublicKey({ key: jwk, format: 'jwk' });
}

function decodePart(part: string): unknown {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

/**
 * Compact JWS (RFC 7515) verification against the trusted issuers' public
 * keys, with Node's own crypto. Only EdDSA (Ed25519) and ES256 verify; HS*,
 * `none` and every other algorithm are refused before any key is looked at,
 * and the algorithm must be the one configured for the issuer named in the
 * token. Keys are pinned or read from the issuer's JWKS (https, or http on
 * loopback only; no redirects; 64 KiB; 5 s), cached and re-read on rotation.
 */
export class IssuerKeyring implements TicketVerifier {
  private readonly issuers = new Map<string, TrustedIssuerConfig>();
  private readonly keys = new Map<string, Key[]>();
  private readonly fetchedAt = new Map<string, number>();
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(issuers: TrustedIssuerConfig[], private readonly logger: Logger) {
    for (const issuer of issuers) {
      this.issuers.set(issuer.issuer, issuer);
      if (issuer.keys) this.keys.set(issuer.issuer, issuer.keys.map(jwk => ({ ...(typeof jwk.kid === 'string' ? { kid: jwk.kid } : {}), key: importPublicKey(jwk, issuer.alg) })));
    }
  }

  /** Splits a compact JWS; undefined if it is not one. */
  private parse(token: string): { header: Record<string, unknown>; payload: unknown; data: Buffer; signature: Buffer } | undefined {
    const parts = token.split('.');
    if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]*$/.test(part))) return undefined;
    try {
      const header = decodePart(parts[0]!);
      const payload = decodePart(parts[1]!);
      if (!header || typeof header !== 'object' || Array.isArray(header)) return undefined;
      return { header: header as Record<string, unknown>, payload, data: Buffer.from(`${parts[0]}.${parts[1]}`, 'ascii'), signature: Buffer.from(parts[2]!, 'base64url') };
    } catch {
      return undefined;
    }
  }

  looksLikeTicket(token: string): boolean {
    return this.parse(token) !== undefined;
  }

  verify(token: string): SignedToken {
    const parsed = this.parse(token);
    if (!parsed) return { ok: false, reason: 'not a signed ticket' };
    const { header, payload } = parsed;
    const alg = header.alg;
    // HS256 and friends would need a shared secret: never accepted, whatever else the ticket says.
    if (!isTicketAlgorithm(alg)) return { ok: false, reason: `algorithm ${JSON.stringify(alg)} is not accepted` };
    if (header.crit !== undefined) return { ok: false, reason: 'critical header parameters are not supported' };
    const iss = payload && typeof payload === 'object' ? (payload as { iss?: unknown }).iss : undefined;
    const issuer = typeof iss === 'string' ? this.issuers.get(iss) : undefined;
    if (!issuer) return { ok: false, reason: 'unknown issuer' };
    if (alg !== issuer.alg) return { ok: false, reason: `the issuer signs with ${issuer.alg}, not ${alg}` };
    const kid = typeof header.kid === 'string' ? header.kid : undefined;
    const candidates = (this.keys.get(issuer.issuer) ?? []).filter(key => kid === undefined || key.kid === undefined || key.kid === kid);
    for (const candidate of candidates) {
      let valid = false;
      try {
        valid = alg === 'EdDSA'
          ? verifySignature(null, parsed.data, candidate.key, parsed.signature)
          : verifySignature('sha256', parsed.data, { key: candidate.key, dsaEncoding: 'ieee-p1363' }, parsed.signature);
      } catch {
        valid = false;
      }
      if (valid) return { ok: true, issuer: issuer.issuer, payload };
    }
    return { ok: false, reason: 'bad signature' };
  }

  /** Reads JWKS for the issuer a token names when its key is unknown or the cache is old. */
  async prepare(token: string | undefined): Promise<void> {
    if (!token) return;
    const parsed = this.parse(token);
    const iss = parsed?.payload && typeof parsed.payload === 'object' ? (parsed.payload as { iss?: unknown }).iss : undefined;
    const issuer = typeof iss === 'string' ? this.issuers.get(iss) : undefined;
    if (!issuer?.jwksUrl) return;
    const kid = typeof parsed!.header.kid === 'string' ? parsed!.header.kid : undefined;
    const known = (this.keys.get(issuer.issuer) ?? []).some(key => kid === undefined || key.kid === kid);
    const age = Date.now() - (this.fetchedAt.get(issuer.issuer) ?? 0);
    if ((known && age < JWKS_TTL_MS) || (!known && age < JWKS_MIN_INTERVAL_MS)) return;
    await this.refresh(issuer);
  }

  /** Reads every JWKS once (startup). */
  async warmUp(): Promise<void> {
    await Promise.all([...this.issuers.values()].filter(issuer => issuer.jwksUrl).map(issuer => this.refresh(issuer)));
  }

  private refresh(issuer: TrustedIssuerConfig): Promise<void> {
    const running = this.inFlight.get(issuer.issuer);
    if (running) return running;
    const run = (async () => {
      this.fetchedAt.set(issuer.issuer, Date.now());
      try {
        const response = await fetch(issuer.jwksUrl!, { redirect: 'error', signal: AbortSignal.timeout(JWKS_TIMEOUT_MS), headers: { accept: 'application/json' } });
        if (!response.ok) throw new Error(`JWKS answered ${response.status}`);
        const body = await response.text();
        if (Buffer.byteLength(body) > JWKS_MAX_BYTES) throw new Error('JWKS too large');
        const document = JSON.parse(body) as { keys?: unknown };
        if (!Array.isArray(document.keys)) throw new Error('JWKS has no "keys"');
        const keys: Key[] = [];
        for (const jwk of document.keys as JsonWebKey[]) {
          try {
            keys.push({ ...(typeof jwk.kid === 'string' ? { kid: jwk.kid } : {}), key: importPublicKey(jwk, issuer.alg) });
          } catch {
            // Keys for other algorithms or uses are skipped.
          }
        }
        this.keys.set(issuer.issuer, keys);
      } catch (error) {
        // Keep the keys already known; a later ticket triggers another try.
        this.logger.warn('Trusted issuer keys could not be read', { issuer: issuer.issuer, reason: (error as Error).message });
      } finally {
        this.inFlight.delete(issuer.issuer);
      }
    })();
    this.inFlight.set(issuer.issuer, run);
    return run;
  }
}
