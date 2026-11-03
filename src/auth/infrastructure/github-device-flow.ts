import { IdentityUnavailableError } from '../application/ports.js';
import type { DeviceCode, DevicePollResult, GitHubIdentity } from '../application/ports.js';

const GITHUB_TIMEOUT_MS = 10000;
const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';
/** Only the profile is read; `read:user` is the narrowest scope GitHub offers for it. */
const DEVICE_SCOPE = 'read:user';

export interface GitHubEndpoints {
  /** Public client ID of the GitHub OAuth app (device flow: no client secret). */
  clientId: string;
  oauthBaseUrl: string;
  apiBaseUrl: string;
}

async function postForm(url: string, form: Record<string, string>, what: string): Promise<{ ok: boolean; body: Record<string, unknown> | null }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form),
    redirect: 'error',
    signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS)
  }).catch(error => {
    throw new IdentityUnavailableError(`${what} failed: ${(error as Error).message}`);
  });
  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  return { ok: response.ok, body: body && typeof body === 'object' ? body : null };
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.ceil(value) : undefined;
}

/**
 * GitHub's OAuth device flow (RFC 8628 as GitHub implements it). Only the
 * public client ID is sent. On success GitHub's access token is used once to
 * read `/user` and then dropped: never returned, stored or logged.
 */
export class GitHubDeviceFlow implements GitHubIdentity {
  constructor(private readonly endpoints: GitHubEndpoints) {}

  async requestDeviceCode(): Promise<DeviceCode> {
    const { ok, body } = await postForm(`${this.endpoints.oauthBaseUrl}/login/device/code`, {
      client_id: this.endpoints.clientId,
      scope: DEVICE_SCOPE
    }, 'GitHub device code request');
    const deviceCode = body?.device_code;
    const userCode = body?.user_code;
    const verificationUri = body?.verification_uri;
    if (!ok || typeof deviceCode !== 'string' || typeof userCode !== 'string' || typeof verificationUri !== 'string') {
      throw new IdentityUnavailableError(`GitHub refused the device code request${body?.error ? ` (${String(body.error)})` : ''}`);
    }
    // Shown as a link and the code as text: refuse anything odd.
    if (!/^https?:\/\//i.test(verificationUri) || !/^[A-Za-z0-9-]{4,32}$/.test(userCode)) {
      throw new IdentityUnavailableError('GitHub returned an unexpected device code response');
    }
    return {
      deviceCode,
      userCode,
      verificationUri,
      expiresInSeconds: positiveInteger(body?.expires_in) ?? 900,
      intervalSeconds: positiveInteger(body?.interval) ?? 5
    };
  }

  async pollDeviceLogin(deviceCode: string): Promise<DevicePollResult> {
    const { body } = await postForm(`${this.endpoints.oauthBaseUrl}/login/oauth/access_token`, {
      client_id: this.endpoints.clientId,
      device_code: deviceCode,
      grant_type: DEVICE_GRANT_TYPE
    }, 'GitHub device token poll');
    if (!body) throw new IdentityUnavailableError('GitHub device token poll returned no JSON');
    const accessToken = body.access_token;
    if (typeof accessToken !== 'string' || accessToken.length === 0) {
      const error = typeof body.error === 'string' ? body.error : 'unknown_error';
      switch (error) {
        case 'authorization_pending': return { kind: 'pending' };
        case 'slow_down': {
          const intervalSeconds = positiveInteger(body.interval);
          return intervalSeconds === undefined ? { kind: 'slow_down' } : { kind: 'slow_down', intervalSeconds };
        }
        case 'expired_token': return { kind: 'expired' };
        case 'access_denied': return { kind: 'denied' };
        default: return { kind: 'error', code: error.slice(0, 64) };
      }
    }
    // GitHub has consumed the device code by now, so a failed lookup is final.
    let user: { login?: unknown } | null;
    try {
      const userResponse = await fetch(`${this.endpoints.apiBaseUrl}/user`, {
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${accessToken}`,
          'user-agent': 'pizarra-auth',
          'x-github-api-version': '2022-11-28'
        },
        redirect: 'error',
        signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS)
      });
      user = userResponse.ok ? await userResponse.json().catch(() => null) as { login?: unknown } | null : null;
    } catch {
      user = null;
    }
    if (!user || typeof user.login !== 'string' || user.login.length === 0) return { kind: 'error', code: 'user_lookup_failed' };
    return { kind: 'login', login: user.login };
  }
}
