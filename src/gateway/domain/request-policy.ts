const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Methods that never change state (no CSRF check needed). */
export function isSafeMethod(method: string): boolean {
  return SAFE_METHODS.has(method.toUpperCase());
}

/**
 * Whether a path is the canvas REST API. Express routes case-insensitively
 * (`/API/elements` reaches `/api/elements`), so paths are classified the
 * same way.
 */
export function isApiPath(path: string): boolean {
  const lower = path.toLowerCase();
  return lower === '/api' || lower.startsWith('/api/');
}

/**
 * Paths forwarded upstream must be plain: no dot segments (raw or
 * percent-encoded), no backslashes, no NUL. Anything else is refused rather
 * than trusting every layer to normalise it the same way.
 */
export function isPlainPath(path: string): boolean {
  if (!path.startsWith('/') || /[\\\u0000]/.test(path) || /%(2e|2f|5c|00)/i.test(path)) return false;
  return !path.split('/').some(segment => segment === '.' || segment === '..');
}

/** `Origin`, or `Referer` when there is no `Origin`, must be exactly `origin`. */
export function isSameOrigin(origin: string, originHeader: string | undefined, referer: string | undefined): boolean {
  if (originHeader !== undefined) return originHeader === origin;
  if (!referer) return false;
  try {
    return new URL(referer).origin === origin;
  } catch {
    return false;
  }
}
