import { readFileSync } from 'node:fs';
import type { JsonWebKey } from 'node:crypto';
import { TRUSTED_ISSUER_PROVIDER, TrustedIssuerProvider } from '../application/ticket-provider.js';
import { TICKET_ALGORITHMS, isTicketAlgorithm } from '../domain/signed-ticket.js';
import { LOOPBACK_URL_HOSTS } from '../../shared/network.js';
import { AuthConfigError, readSecretVariable, readTtl } from '../infrastructure/config-error.js';
import type { Env } from '../infrastructure/config-error.js';
import { IssuerKeyring, importPublicKey } from '../infrastructure/issuer-keys.js';
import type { TrustedIssuerConfig } from '../infrastructure/issuer-keys.js';
import { createTicketRouter } from '../presentation/http/ticket-router.js';
import type { AuthPluginDefinition } from './types.js';

export interface TrustedIssuerPluginConfig {
  issuers: TrustedIssuerConfig[];
  audience: string;
  sessionTtlSeconds: number;
}

function parseIssuers(raw: string): TrustedIssuerConfig[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AuthConfigError('TRUSTED_ISSUERS must be a JSON array of {"issuer", "alg", "jwks_url" or "keys"}.');
  }
  if (!Array.isArray(parsed) || parsed.length === 0) throw new AuthConfigError('TRUSTED_ISSUERS must be a non-empty JSON array.');
  const seen = new Set<string>();
  return parsed.map((entry, index) => {
    const where = `TRUSTED_ISSUERS[${index}]`;
    if (!entry || typeof entry !== 'object') throw new AuthConfigError(`${where} must be an object.`);
    const { issuer, alg, jwks_url: jwksUrl, keys } = entry as { issuer?: unknown; alg?: unknown; jwks_url?: unknown; keys?: unknown };
    if (typeof issuer !== 'string' || !issuer.trim() || issuer.length > 200) throw new AuthConfigError(`${where}.issuer must be the issuer's "iss" value.`);
    if (seen.has(issuer)) throw new AuthConfigError(`${where}.issuer ${JSON.stringify(issuer)} is listed twice.`);
    seen.add(issuer);
    if (!isTicketAlgorithm(alg)) {
      throw new AuthConfigError(`${where}.alg must be one of ${TICKET_ALGORITHMS.join(', ')} (got ${JSON.stringify(alg)}); HS* and other algorithms are never accepted.`);
    }
    if ((jwksUrl === undefined) === (keys === undefined)) throw new AuthConfigError(`${where} needs exactly one of "jwks_url" and "keys".`);
    if (jwksUrl !== undefined) {
      let url: URL;
      try {
        url = new URL(String(jwksUrl));
      } catch {
        throw new AuthConfigError(`${where}.jwks_url must be an absolute URL.`);
      }
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK_URL_HOSTS.has(url.hostname))) {
        throw new AuthConfigError(`${where}.jwks_url must use https (http only on loopback); pin the keys with "keys" otherwise.`);
      }
      return { issuer, alg, jwksUrl: url.toString() };
    }
    if (!Array.isArray(keys) || keys.length === 0) throw new AuthConfigError(`${where}.keys must be a non-empty array of public JWKs.`);
    for (const [keyIndex, jwk] of keys.entries()) {
      try {
        importPublicKey(jwk as JsonWebKey, alg);
      } catch (error) {
        throw new AuthConfigError(`${where}.keys[${keyIndex}]: ${(error as Error).message}.`);
      }
    }
    return { issuer, alg, keys: keys as JsonWebKey[] };
  });
}

/**
 * Adapter (b): signed board tickets from trusted issuers (Hagalink Projects
 * is the first). `TRUSTED_ISSUERS` names each issuer, its algorithm (EdDSA
 * or ES256) and its public keys (a JWKS URL or pinned JWKs).
 */
export const trustedIssuerPlugin: AuthPluginDefinition<TrustedIssuerPluginConfig> = {
  id: TRUSTED_ISSUER_PROVIDER,

  missing(env: Env): string[] {
    return env.TRUSTED_ISSUERS?.trim() || env.TRUSTED_ISSUERS_FILE?.trim() ? [] : ['TRUSTED_ISSUERS'];
  },

  configure(env: Env, base) {
    const raw = readSecretVariable(env, 'TRUSTED_ISSUERS', path => readFileSync(path, 'utf8'))!;
    return {
      config: {
        issuers: parseIssuers(raw),
        audience: base.issuer,
        sessionTtlSeconds: readTtl(env, 'TRUSTED_ISSUER_SESSION_TTL_SECONDS', 8 * 3600, 60, 86400)
      },
      warnings: []
    };
  },

  build(context, config) {
    const keyring = new IssuerKeyring(config.issuers, context.logger);
    const prefix = `${context.cookies.session.startsWith('__Host-') ? '__Host-' : ''}wb_b_`;
    const provider = new TrustedIssuerProvider(
      keyring, context.admission, context.store, context.signer, context.clock, config.audience,
      board => `${prefix}${board}`, prefix, config.sessionTtlSeconds
    );
    return { provider, router: createTicketRouter(provider, context.cookies), warmUp: () => keyring.warmUp() };
  }
};
