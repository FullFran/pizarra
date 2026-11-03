const LOOPBACK_BIND_HOSTS = new Set(['localhost', '::1', '[::1]']);

/** Whether a bind address (`HOST`) only accepts connections from this machine. */
export function isLoopbackBindHost(host: string): boolean {
  return LOOPBACK_BIND_HOSTS.has(host) || /^127(\.\d{1,3}){3}$/.test(host);
}

/** URL hostnames that name this machine (http is tolerated only for these). */
export const LOOPBACK_URL_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * Validates `PUBLIC_BASE_URL`: an absolute http(s) URL without credentials,
 * query or fragment. Returns it without a trailing slash, or undefined.
 */
export function parsePublicBaseUrl(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`PUBLIC_BASE_URL must be an absolute http(s) URL, got ${JSON.stringify(value)}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`PUBLIC_BASE_URL must use http or https, got ${JSON.stringify(value)}`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`PUBLIC_BASE_URL must not carry credentials, a query or a fragment, got ${JSON.stringify(value)}`);
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
}

/**
 * Express `trust proxy` setting from `TRUST_PROXY`: off by default; `true`,
 * a hop count, or Express's address list syntax.
 */
export function parseTrustProxy(raw: string | undefined): boolean | number | string {
  const value = raw?.trim();
  if (!value || value === 'false' || value === '0') return false;
  if (value === 'true') return true;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}
