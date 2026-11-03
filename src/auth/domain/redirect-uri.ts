export const MAX_URI_LENGTH = 2000;
const LOOPBACK_REDIRECT_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * Redirect URI policy: any https URI (ChatGPT's
 * `https://chatgpt.com/connector_platform_oauth_redirect` included), or an
 * http loopback URI for native/CLI clients (RFC 8252). No fragments, no
 * credentials, no custom schemes.
 */
export function isAllowedRedirectUri(raw: unknown): raw is string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_URI_LENGTH) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.hash || raw.includes('#') || url.username || url.password) return false;
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && LOOPBACK_REDIRECT_HOSTS.has(url.hostname);
}

/**
 * Exact string match against the registered URIs; for http loopback URIs the
 * port may differ (RFC 8252 §7.3: CLI clients bind an ephemeral port).
 */
export function redirectUriMatches(registered: readonly string[], requested: string): boolean {
  if (registered.includes(requested)) return true;
  let target: URL;
  try {
    target = new URL(requested);
  } catch {
    return false;
  }
  if (target.protocol !== 'http:' || !LOOPBACK_REDIRECT_HOSTS.has(target.hostname)) return false;
  return registered.some(candidate => {
    try {
      const url = new URL(candidate);
      return url.protocol === 'http:' && url.hostname === target.hostname &&
        url.pathname === target.pathname && url.search === target.search;
    } catch {
      return false;
    }
  });
}
