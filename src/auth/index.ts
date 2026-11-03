/**
 * The auth bounded context: an OAuth 2.1 authorization server with GitHub
 * sign-in, and the "who is this request?" check. It imports nothing from the
 * gateway or the canvas; the protected resources it issues tokens for come
 * from configuration.
 */
import type express from 'express';
import { AccessTokenVerifier } from './application/access-tokens.js';
import { AuthorizationCodes } from './application/authorization-codes.js';
import { AuthorizationService } from './application/authorize.js';
import { ClientRegistry } from './application/clients.js';
import { DeviceSignIn } from './application/device-sign-in.js';
import { SessionService } from './application/sessions.js';
import { TokenService } from './application/tokens.js';
import type { AuthSettings } from './application/settings.js';
import type { Logger } from './application/ports.js';
import { SafeClientMetadataFetcher } from './infrastructure/cimd-fetcher.js';
import type { AuthOnConfig } from './infrastructure/env-config.js';
import { GitHubDeviceFlow } from './infrastructure/github-device-flow.js';
import { JsonFileTokenStore } from './infrastructure/json-token-store.js';
import { HmacTicketSigner, cryptoRandom, sha256Hasher, systemClock } from './infrastructure/node-crypto.js';
import type { SafeFetchOptions } from './infrastructure/ssrf-fetch.js';
import { CookieJar } from './presentation/http/http-helpers.js';
import { createOAuthRouter } from './presentation/http/oauth-router.js';
import { HttpRequestAuthenticator } from './presentation/http/request-authenticator.js';

export { resolveAuthConfig, AuthConfigError } from './infrastructure/env-config.js';
export type { AuthConfig, AuthOnConfig, AuthOffConfig } from './infrastructure/env-config.js';
export { HttpRequestAuthenticator } from './presentation/http/request-authenticator.js';
export type { Authentication, Principal, CredentialHeaders, AuthenticateOptions } from './presentation/http/request-authenticator.js';

export interface AuthModule {
  settings: AuthSettings;
  /** Metadata documents and `/oauth/*` endpoints. Mount at the app root. */
  router: express.Router;
  authenticator: HttpRequestAuthenticator;
}

export interface AuthDeps {
  logger: Logger;
  /** Options for fetching Client ID Metadata Documents (tests inject a guard and CA). */
  cimdFetch?: SafeFetchOptions;
  /** Name shown in protected resource metadata. */
  resourceName?: string;
}

export function buildAuth(config: AuthOnConfig, deps: AuthDeps): AuthModule {
  const settings = config.settings;
  const clock = systemClock;
  const random = cryptoRandom;
  const hasher = sha256Hasher;
  const signer = new HmacTicketSigner(config.secret.secret(), clock);
  const store = new JsonFileTokenStore(config.storePath, clock, random);
  const cookies = new CookieJar(config.secureCookies);
  const sessions = new SessionService(settings, signer, random);
  const clients = new ClientRegistry(store, new SafeClientMetadataFetcher(deps.cimdFetch), hasher, random, clock);
  const codes = new AuthorizationCodes(hasher, random, clock);
  const github = new GitHubDeviceFlow(config.github);
  const router = createOAuthRouter({
    settings,
    cookies,
    sessions,
    clients,
    deviceSignIn: new DeviceSignIn(settings, github, signer, random, clock, deps.logger),
    authorization: new AuthorizationService(settings, clients, sessions, codes, signer, random, clock),
    tokens: new TokenService(settings, store, clients, codes, hasher, random, clock, deps.logger),
    ...(config.github.appName ? { appName: config.github.appName } : {}),
    resourceName: deps.resourceName ?? 'pizarra'
  });
  const authenticator = new HttpRequestAuthenticator(settings, cookies, sessions, new AccessTokenVerifier(settings, store, hasher));
  return { settings, router, authenticator };
}
