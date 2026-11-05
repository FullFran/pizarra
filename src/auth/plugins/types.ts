import type express from 'express';
import type { AccessPolicy, IdentityProvider } from '../application/identity.js';
import type { Clock, Hasher, Logger, RandomSource, TicketSigner, TokenStore } from '../application/ports.js';
import type { AuthSettings } from '../application/settings.js';
import type { Env } from '../infrastructure/config-error.js';
import type { SafeFetchOptions } from '../infrastructure/ssrf-fetch.js';
import type { CookieJar } from '../presentation/http/http-helpers.js';
import type { ChallengeBuilder } from '../presentation/http/request-authenticator.js';

/**
 * Decides whether a trusted issuer's ticket may open a board (creating an
 * issuer-owned board on its first ticket). Supplied by the composition root;
 * auth knows nothing about boards.
 */
export interface BoardAdmission {
  admitIssuer(issuer: string, board: string): boolean;
}

/** Everything a plugin may build on; all shared across plugins. */
export interface AuthPluginContext {
  settings: AuthSettings;
  signer: TicketSigner;
  store: TokenStore;
  cookies: CookieJar;
  clock: Clock;
  random: RandomSource;
  hasher: Hasher;
  logger: Logger;
  policy: AccessPolicy;
  admission: BoardAdmission;
  /** Options for fetching remote documents (tests inject a guard and CA). */
  fetchOptions?: SafeFetchOptions;
  resourceName: string;
}

/** A built plugin: its identity provider and, if it has pages or endpoints, their routes. */
export interface AuthPlugin {
  provider: IdentityProvider;
  /** Mounted at the root, before the canvas. */
  router?: express.Router;
  /** `WWW-Authenticate` for protected resources, when this plugin defines discovery (OAuth). */
  challenge?: ChallengeBuilder;
  /** Started once at startup (e.g. fetch keys); failures are logged, not fatal. */
  warmUp?(): Promise<void>;
}

/**
 * An auth adapter. Enabling it is configuration only (its id in
 * `AUTH_PROVIDERS`); adding one is writing one of these and listing it in
 * `registry.ts`. See docs/auth.md, "Writing an auth adapter".
 */
export interface AuthPluginDefinition<C = unknown> {
  readonly id: string;
  /** Required variables that are unset (reported together with the core ones). */
  missing(env: Env): string[];
  /** Reads and validates the plugin's variables; throws `AuthConfigError` on a bad value. */
  configure(env: Env, base: { issuer: string; dataDir: string }): { config: C; warnings: string[] };
  build(context: AuthPluginContext, config: C): AuthPlugin;
}
