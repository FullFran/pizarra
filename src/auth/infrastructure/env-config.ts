import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Allowlist } from '../domain/allowlist.js';
import type { AuthSettings } from '../application/settings.js';
import type { SecretProvider } from '../application/ports.js';
import { LOOPBACK_URL_HOSTS, isLoopbackBindHost, parsePublicBaseUrl } from '../../shared/network.js';
import { MIN_SECRET_LENGTH, SecretError, StaticSecret, loadOrCreateGeneratedSecret } from './signing-secret.js';
import type { GitHubEndpoints } from './github-device-flow.js';
import { AuthConfigError, readSecretVariable, readTtl } from './config-error.js';
import type { Env } from './config-error.js';
import { AUTH_PLUGINS, DEFAULT_AUTH_PROVIDERS } from '../plugins/registry.js';

export { AuthConfigError } from './config-error.js';

export interface AuthOffConfig {
  mode: 'off';
  /** True when auth was switched off explicitly on a non-loopback bind. */
  insecure: boolean;
}

export interface AuthOnConfig {
  mode: 'oauth';
  settings: AuthSettings;
  /** Whether cookies get `Secure` and the `__Host-` prefix (the issuer is https). */
  secureCookies: boolean;
  /** Present when the GitHub provider is enabled. */
  github?: GitHubEndpoints & { appName?: string };
  /** Enabled auth adapters (`AUTH_PROVIDERS`), in order, with their own configuration. */
  providers?: Array<{ id: string; config: unknown }>;
  /** Non-fatal configuration notes to log at startup. */
  warnings: string[];
  secret: SecretProvider;
  /** JSON file holding hashed tokens and registered clients (0600). */
  storePath: string;
}

export type AuthConfig = AuthOffConfig | AuthOnConfig;

export interface AuthConfigOptions {
  /** Paths of the protected resources on the issuer's origin; each becomes an audience (RFC 8707). */
  resourcePaths: string[];
}

function readProviders(env: Env): string[] {
  const raw = env.AUTH_PROVIDERS?.trim();
  if (!raw) return [...DEFAULT_AUTH_PROVIDERS];
  const ids = [...new Set(raw.split(',').map(id => id.trim().toLowerCase()).filter(Boolean))];
  if (ids.length === 0) throw new AuthConfigError('AUTH_PROVIDERS must list at least one provider.');
  for (const id of ids) {
    if (!Object.prototype.hasOwnProperty.call(AUTH_PLUGINS, id)) {
      throw new AuthConfigError(`AUTH_PROVIDERS lists an unknown provider ${JSON.stringify(id)}; known: ${Object.keys(AUTH_PLUGINS).join(', ')}.`);
    }
  }
  return ids;
}

/**
 * Decides whether authentication is on, from the bind host and env.
 *
 * - Loopback bind and no `AUTH_MODE`: off (zero-config local use).
 * - Non-loopback bind, or `AUTH_MODE=oauth`: on; every required variable
 *   must be present or this throws naming each missing one.
 * - `AUTH_MODE=off` on a non-loopback bind: refused unless
 *   `ALLOW_INSECURE_NO_AUTH=true`.
 *
 * The signing secret is resolved last, so a configuration error never
 * leaves a new secret file behind.
 */
export function resolveAuthConfig(bindHost: string, env: Env, options: AuthConfigOptions): AuthConfig {
  const mode = env.AUTH_MODE?.trim().toLowerCase() ?? '';
  if (mode !== '' && mode !== 'off' && mode !== 'oauth') {
    throw new AuthConfigError(`AUTH_MODE must be "off" or "oauth", got ${JSON.stringify(env.AUTH_MODE)}.`);
  }
  const loopback = isLoopbackBindHost(bindHost);
  if (mode === 'off' || (mode === '' && loopback)) {
    if (loopback) return { mode: 'off', insecure: false };
    if (env.ALLOW_INSECURE_NO_AUTH?.trim() !== 'true') {
      throw new AuthConfigError(
        `Refusing to start without authentication on non-loopback HOST=${bindHost}: AUTH_MODE=off ` +
        'exposes the canvas, REST API, WebSocket and /mcp to anyone who can reach this address. ' +
        'Set ALLOW_INSECURE_NO_AUTH=true only if another layer authenticates every request.'
      );
    }
    return { mode: 'off', insecure: true };
  }

  const providerIds = readProviders(env);
  const plugins = providerIds.map(id => AUTH_PLUGINS[id]!);
  const missing: string[] = [];
  const reason = mode === 'oauth' ? 'AUTH_MODE=oauth' : `HOST=${bindHost} is not loopback`;
  let issuer: string | undefined;
  try {
    issuer = parsePublicBaseUrl(env.PUBLIC_BASE_URL);
  } catch (error) {
    throw new AuthConfigError((error as Error).message);
  }
  if (!issuer) missing.push('PUBLIC_BASE_URL');
  const pluginMissing = plugins.flatMap(plugin => plugin.missing(env));
  missing.push(...pluginMissing.filter(name => name !== 'ALLOWED_GITHUB_LOGINS'));
  const explicitSecret = readSecretVariable(env, 'AUTH_SECRET', path => readFileSync(path, 'utf8'));
  if (pluginMissing.includes('ALLOWED_GITHUB_LOGINS')) missing.push('ALLOWED_GITHUB_LOGINS');
  const dataDir = env.EXCALIDRAW_DATA_DIR?.trim();
  if (!dataDir) missing.push('EXCALIDRAW_DATA_DIR');
  if (missing.length > 0) {
    throw new AuthConfigError(
      `Authentication is required (${reason}) but these variables are missing: ${missing.join(', ')}. See docs/auth.md.`
    );
  }

  const url = new URL(issuer!);
  if (url.pathname !== '/') {
    throw new AuthConfigError(`PUBLIC_BASE_URL must be an origin without a path when authentication is on, got ${JSON.stringify(issuer)}.`);
  }
  if (url.protocol !== 'https:' && !LOOPBACK_URL_HOSTS.has(url.hostname)) {
    throw new AuthConfigError(
      `PUBLIC_BASE_URL must use https when authentication is on (http is only accepted for loopback hosts), got ${JSON.stringify(issuer)}.`
    );
  }
  if (explicitSecret !== undefined && explicitSecret.length < MIN_SECRET_LENGTH) {
    throw new AuthConfigError(`AUTH_SECRET must be at least ${MIN_SECRET_LENGTH} characters (use e.g. \`openssl rand -base64 48\`).`);
  }
  const base = url.origin;
  const warnings: string[] = [];
  const providers = plugins.map(plugin => {
    const configured = plugin.configure(env, { issuer: base, dataDir: resolve(dataDir!) });
    warnings.push(...configured.warnings);
    return { id: plugin.id, config: configured.config };
  });
  const github = providers.find(provider => provider.id === 'github')?.config as (GitHubEndpoints & { appName?: string; allowedLogins: Allowlist }) | undefined;
  const accessTokenTtlSeconds = readTtl(env, 'AUTH_ACCESS_TOKEN_TTL_SECONDS', 3600, 1, 86400);
  const refreshTokenTtlSeconds = readTtl(env, 'AUTH_REFRESH_TOKEN_TTL_SECONDS', 30 * 86400, 60, 90 * 86400);
  const sessionTtlSeconds = readTtl(env, 'AUTH_SESSION_TTL_SECONDS', 7 * 86400, 60, 30 * 86400);
  if (options.resourcePaths.length === 0 || options.resourcePaths.some(path => !path.startsWith('/'))) {
    throw new AuthConfigError('at least one protected resource path starting with "/" is required');
  }

  let secret: SecretProvider;
  try {
    secret = explicitSecret !== undefined ? new StaticSecret(explicitSecret) : loadOrCreateGeneratedSecret(resolve(dataDir!));
  } catch (error) {
    if (error instanceof SecretError) throw new AuthConfigError(error.message);
    throw error;
  }

  return {
    mode: 'oauth',
    settings: {
      issuer: base,
      resources: options.resourcePaths.map(path => `${base}${path}`),
      // The GitHub admins; without the GitHub provider nobody signs in with GitHub.
      allowedLogins: github?.allowedLogins ?? new Allowlist([]),
      accessTokenTtlSeconds,
      refreshTokenTtlSeconds,
      sessionTtlSeconds,
      authorizationCodeTtlSeconds: 60
    },
    secureCookies: url.protocol === 'https:',
    ...(github ? { github: { clientId: github.clientId, ...(github.appName ? { appName: github.appName } : {}), oauthBaseUrl: github.oauthBaseUrl, apiBaseUrl: github.apiBaseUrl } } : {}),
    providers,
    warnings,
    secret,
    storePath: join(resolve(dataDir!), 'auth-store.json')
  };
}
