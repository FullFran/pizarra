import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Allowlist, InvalidLoginError } from '../domain/allowlist.js';
import type { AuthSettings } from '../application/settings.js';
import type { SecretProvider } from '../application/ports.js';
import { LOOPBACK_URL_HOSTS, isLoopbackBindHost, parsePublicBaseUrl } from '../../shared/network.js';
import { MIN_SECRET_LENGTH, SecretError, StaticSecret, loadOrCreateGeneratedSecret } from './signing-secret.js';
import type { GitHubEndpoints } from './github-device-flow.js';

export class AuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthConfigError';
  }
}

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
  github: GitHubEndpoints & { appName?: string };
  /** Non-fatal configuration notes to log at startup. */
  warnings: string[];
  secret: SecretProvider;
  /** JSON file holding hashed tokens and registered clients (0600). */
  storePath: string;
}

export type AuthConfig = AuthOffConfig | AuthOnConfig;

type Env = Record<string, string | undefined>;

export interface AuthConfigOptions {
  /** Paths of the protected resources on the issuer's origin; each becomes an audience (RFC 8707). */
  resourcePaths: string[];
}

function readSecret(env: Env, name: string): string | undefined {
  const direct = env[name]?.trim();
  const filePath = env[`${name}_FILE`]?.trim();
  if (direct && filePath) throw new AuthConfigError(`Set only one of ${name} and ${name}_FILE.`);
  if (direct) return direct;
  if (filePath) {
    let value: string;
    try {
      value = readFileSync(filePath, 'utf8').trim();
    } catch (error) {
      throw new AuthConfigError(`Cannot read ${name}_FILE (${filePath}): ${(error as Error).message}`);
    }
    if (value) return value;
    throw new AuthConfigError(`${name}_FILE (${filePath}) is empty.`);
  }
  return undefined;
}

function readTtl(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) throw new AuthConfigError(`${name} must be a whole number of seconds, got ${JSON.stringify(raw)}.`);
  const value = Number(raw);
  if (value < min || value > max) throw new AuthConfigError(`${name} must be between ${min} and ${max}, got ${value}.`);
  return value;
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

  const missing: string[] = [];
  const reason = mode === 'oauth' ? 'AUTH_MODE=oauth' : `HOST=${bindHost} is not loopback`;
  let issuer: string | undefined;
  try {
    issuer = parsePublicBaseUrl(env.PUBLIC_BASE_URL);
  } catch (error) {
    throw new AuthConfigError((error as Error).message);
  }
  if (!issuer) missing.push('PUBLIC_BASE_URL');
  const clientId = env.GITHUB_CLIENT_ID?.trim();
  if (!clientId) missing.push('GITHUB_CLIENT_ID');
  const warnings: string[] = [];
  for (const name of ['GITHUB_CLIENT_SECRET', 'GITHUB_CLIENT_SECRET_FILE']) {
    if (env[name]?.trim()) {
      warnings.push(`${name} is set but no longer used: GitHub login uses the device flow with the public client ID only. Remove it.`);
    }
  }
  const explicitSecret = readSecret(env, 'AUTH_SECRET');
  const loginsRaw = env.ALLOWED_GITHUB_LOGINS?.trim();
  if (!loginsRaw) missing.push('ALLOWED_GITHUB_LOGINS');
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
  let allowedLogins: Allowlist;
  try {
    allowedLogins = Allowlist.parse(loginsRaw!);
  } catch (error) {
    if (error instanceof InvalidLoginError) throw new AuthConfigError(error.message);
    throw error;
  }
  const appName = env.GITHUB_APP_NAME?.trim();
  if (appName !== undefined && appName.length > 100) throw new AuthConfigError('GITHUB_APP_NAME must be at most 100 characters.');
  const oauthBaseUrl = normalizeBaseUrl('GITHUB_OAUTH_BASE_URL', env.GITHUB_OAUTH_BASE_URL?.trim() || 'https://github.com');
  const apiBaseUrl = normalizeBaseUrl('GITHUB_API_BASE_URL', env.GITHUB_API_BASE_URL?.trim() || 'https://api.github.com');
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

  const base = url.origin;
  return {
    mode: 'oauth',
    settings: {
      issuer: base,
      resources: options.resourcePaths.map(path => `${base}${path}`),
      allowedLogins,
      accessTokenTtlSeconds,
      refreshTokenTtlSeconds,
      sessionTtlSeconds,
      authorizationCodeTtlSeconds: 60
    },
    secureCookies: url.protocol === 'https:',
    github: { clientId: clientId!, ...(appName ? { appName } : {}), oauthBaseUrl, apiBaseUrl },
    warnings,
    secret,
    storePath: join(resolve(dataDir!), 'auth-store.json')
  };
}
