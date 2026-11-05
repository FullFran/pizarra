import { AccessTokenVerifier } from '../application/access-tokens.js';
import { AuthorizationCodes } from '../application/authorization-codes.js';
import { AuthorizationService } from '../application/authorize.js';
import { ClientRegistry } from '../application/clients.js';
import { DeviceSignIn } from '../application/device-sign-in.js';
import { GITHUB_PROVIDER, GitHubProvider } from '../application/github-provider.js';
import { SessionService } from '../application/sessions.js';
import { TokenService } from '../application/tokens.js';
import { Allowlist, InvalidLoginError } from '../domain/allowlist.js';
import { WHITEBOARD_SCOPE } from '../domain/scope.js';
import { SafeClientMetadataFetcher } from '../infrastructure/cimd-fetcher.js';
import { AuthConfigError } from '../infrastructure/config-error.js';
import type { Env } from '../infrastructure/config-error.js';
import { GitHubDeviceFlow } from '../infrastructure/github-device-flow.js';
import type { GitHubEndpoints } from '../infrastructure/github-device-flow.js';
import { createOAuthRouter, resourceMetadataPath } from '../presentation/http/oauth-router.js';
import type { AuthPluginDefinition } from './types.js';

export interface GitHubPluginConfig extends GitHubEndpoints {
  appName?: string;
  allowedLogins: Allowlist;
}

function normalizeBaseUrl(name: string, raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AuthConfigError(`${name} must be an absolute URL, got ${JSON.stringify(raw)}.`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new AuthConfigError(`${name} must use http or https, got ${JSON.stringify(raw)}.`);
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
}

/**
 * Adapter (a), the default: GitHub sign-in with the device flow (public
 * client ID only) for people, and this server's OAuth 2.1 authorization
 * server for their agents.
 */
export const githubPlugin: AuthPluginDefinition<GitHubPluginConfig> = {
  id: GITHUB_PROVIDER,

  missing(env: Env): string[] {
    const missing: string[] = [];
    if (!env.GITHUB_CLIENT_ID?.trim()) missing.push('GITHUB_CLIENT_ID');
    if (!env.ALLOWED_GITHUB_LOGINS?.trim()) missing.push('ALLOWED_GITHUB_LOGINS');
    return missing;
  },

  configure(env: Env) {
    const warnings: string[] = [];
    for (const name of ['GITHUB_CLIENT_SECRET', 'GITHUB_CLIENT_SECRET_FILE']) {
      if (env[name]?.trim()) {
        warnings.push(`${name} is set but no longer used: GitHub login uses the device flow with the public client ID only. Remove it.`);
      }
    }
    let allowedLogins: Allowlist;
    try {
      allowedLogins = Allowlist.parse(env.ALLOWED_GITHUB_LOGINS!.trim());
    } catch (error) {
      if (error instanceof InvalidLoginError) throw new AuthConfigError(error.message);
      throw error;
    }
    const appName = env.GITHUB_APP_NAME?.trim();
    if (appName !== undefined && appName.length > 100) throw new AuthConfigError('GITHUB_APP_NAME must be at most 100 characters.');
    const oauthBaseUrl = normalizeBaseUrl('GITHUB_OAUTH_BASE_URL', env.GITHUB_OAUTH_BASE_URL?.trim() || 'https://github.com');
    const apiBaseUrl = normalizeBaseUrl('GITHUB_API_BASE_URL', env.GITHUB_API_BASE_URL?.trim() || 'https://api.github.com');
    return {
      config: { clientId: env.GITHUB_CLIENT_ID!.trim(), ...(appName ? { appName } : {}), oauthBaseUrl, apiBaseUrl, allowedLogins },
      warnings
    };
  },

  build(context, config) {
    const { settings, signer, store, cookies, clock, random, hasher, logger, policy } = context;
    const sessions = new SessionService(settings, signer, random, policy);
    const clients = new ClientRegistry(store, new SafeClientMetadataFetcher(context.fetchOptions), hasher, random, clock);
    const codes = new AuthorizationCodes(store, hasher, random);
    const verifier = new AccessTokenVerifier(settings, store, hasher, policy);
    const router = createOAuthRouter({
      settings,
      cookies,
      sessions,
      clients,
      policy,
      deviceSignIn: new DeviceSignIn(settings, new GitHubDeviceFlow(config), signer, random, clock, logger, store, policy),
      authorization: new AuthorizationService(settings, clients, sessions, codes, signer, random, clock, store, policy),
      tokens: new TokenService(settings, store, clients, codes, hasher, random, clock, logger, policy),
      ...(config.appName ? { appName: config.appName } : {}),
      resourceName: context.resourceName
    });
    const challenge = (resource: string, error?: string, description?: string): string => {
      const metadata = `${settings.issuer}${resourceMetadataPath(settings, resource)}`;
      let value = `Bearer resource_metadata="${metadata}", scope="${WHITEBOARD_SCOPE}"`;
      if (error) value += `, error="${error}"`;
      if (description) value += `, error_description="${description}"`;
      return value;
    };
    return { provider: new GitHubProvider(sessions, verifier, cookies.session), router, challenge };
  }
};
