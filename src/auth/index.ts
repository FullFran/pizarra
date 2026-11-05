/**
 * The auth bounded context: pluggable identity providers (GitHub sign-in
 * with an OAuth 2.1 authorization server, trusted issuers' signed tickets,
 * …) and the "who is this request?" check. It imports nothing from the
 * gateway, the boards or the canvas; what people may open comes in through
 * the `AccessPolicy` and `BoardAdmission` ports.
 */
import express from 'express';
import { StaticAccessPolicy } from './application/identity.js';
import type { AccessPolicy } from './application/identity.js';
import type { AuthSettings } from './application/settings.js';
import type { Logger } from './application/ports.js';
import type { AuthOnConfig } from './infrastructure/env-config.js';
import { JsonFileTokenStore } from './infrastructure/json-token-store.js';
import { HmacTicketSigner, cryptoRandom, sha256Hasher, systemClock } from './infrastructure/node-crypto.js';
import type { SafeFetchOptions } from './infrastructure/ssrf-fetch.js';
import { CookieJar, isSameOrigin } from './presentation/http/http-helpers.js';
import { sendErrorPage } from './presentation/http/pages.js';
import { HttpRequestAuthenticator } from './presentation/http/request-authenticator.js';
import { AUTH_PLUGINS } from './plugins/registry.js';
import type { AuthPlugin, AuthPluginContext, BoardAdmission } from './plugins/types.js';

export { resolveAuthConfig, AuthConfigError } from './infrastructure/env-config.js';
export type { AuthConfig, AuthOnConfig, AuthOffConfig } from './infrastructure/env-config.js';
export { HttpRequestAuthenticator } from './presentation/http/request-authenticator.js';
export type { Authentication, Principal, CredentialHeaders, AuthenticateOptions } from './presentation/http/request-authenticator.js';
export type { AccessPolicy, Identity, IdentityProvider } from './application/identity.js';
export type { BoardAdmission, AuthPluginDefinition } from './plugins/types.js';
export { AUTH_PLUGINS } from './plugins/registry.js';

export interface AuthModule {
  settings: AuthSettings;
  /** Metadata documents, `/oauth/*` and every provider's own endpoints. Mount at the app root. */
  router: express.Router;
  authenticator: HttpRequestAuthenticator;
  /** Ids of the enabled providers, in order. */
  providers: string[];
  /** Fetches what providers need ahead of the first request (keys); never throws. */
  warmUp(): Promise<void>;
}

export interface AuthDeps {
  logger: Logger;
  /** Options for fetching remote documents: Client ID Metadata Documents, JWKS (tests inject a guard and CA). */
  cimdFetch?: SafeFetchOptions;
  /** Name shown in protected resource metadata. */
  resourceName?: string;
  /** Who may sign in and which resources exist; default: `ALLOWED_GITHUB_LOGINS` and the configured resources. */
  policy?: AccessPolicy;
  /** Whether a trusted issuer's ticket opens a board; default: never. */
  admission?: BoardAdmission;
}

/** Without the GitHub provider there is no OAuth discovery to point at. */
function plainChallenge(): string {
  return 'Bearer realm="pizarra"';
}

export function buildAuth(config: AuthOnConfig, deps: AuthDeps): AuthModule {
  const settings = config.settings;
  const clock = systemClock;
  const random = cryptoRandom;
  const cookies = new CookieJar(config.secureCookies);
  const policy = deps.policy ?? new StaticAccessPolicy(settings);
  const context: AuthPluginContext = {
    settings,
    signer: new HmacTicketSigner(config.secret.secret(), clock),
    store: new JsonFileTokenStore(config.storePath, clock, random),
    cookies, clock, random, hasher: sha256Hasher, logger: deps.logger, policy,
    admission: deps.admission ?? { admitIssuer: () => false },
    ...(deps.cimdFetch ? { fetchOptions: deps.cimdFetch } : {}),
    resourceName: deps.resourceName ?? 'pizarra'
  };
  // A configuration built by hand before providers existed means GitHub alone.
  const enabled = config.providers ?? (config.github ? [{ id: 'github', config: { ...config.github, allowedLogins: settings.allowedLogins } }] : []);
  const plugins: AuthPlugin[] = enabled.map(({ id, config: pluginConfig }) => AUTH_PLUGINS[id]!.build(context, pluginConfig));
  const challenge = plugins.find(plugin => plugin.challenge)?.challenge ?? plainChallenge;
  const authenticator = new HttpRequestAuthenticator(plugins.map(plugin => plugin.provider), settings.issuer, challenge);

  const router = express.Router();
  // Sign-out clears every provider's session cookie (GitHub, board tickets, …).
  router.post('/oauth/logout', express.urlencoded({ extended: false, limit: '16kb' }), (req, res) => {
    if (!isSameOrigin(req.headers, settings.issuer)) return sendErrorPage(res, 403, 'Forbidden', 'Cross-site request rejected.');
    const names = new Set([cookies.session, ...authenticator.sessionCookieNames(req.headers.cookie)]);
    for (const name of names) cookies.clear(res, name);
    res.redirect(303, '/');
  });
  for (const plugin of plugins) if (plugin.router) router.use(plugin.router);

  const warmUp = async () => {
    await Promise.all(plugins.map(async plugin => {
      try {
        await plugin.warmUp?.();
      } catch (error) {
        deps.logger.warn('Auth provider warm-up failed', { provider: plugin.provider.id, reason: (error as Error).message });
      }
    }));
  };
  return { settings, router, authenticator, providers: plugins.map(plugin => plugin.provider.id), warmUp };
}
