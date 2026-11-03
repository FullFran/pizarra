/**
 * A same-origin path to go back to after sign-in, or "/". Browsers drop ASCII
 * tab/CR/LF from URLs and treat "\" like "/", so "/\t/evil" or "/\evil" would
 * navigate off-site; anything with control characters or backslashes is
 * refused, and the result must resolve to the same origin.
 */
export function safeReturnPath(value: string | undefined): string {
  if (!value || value.length > 4096 || !value.startsWith('/') || value.startsWith('//')) return '/';
  if (/[\u0000-\u001f\u007f\\]/.test(value)) return '/';
  try {
    const base = new URL('https://return-path.invalid');
    const resolved = new URL(value, base);
    if (resolved.origin !== base.origin) return '/';
    return `${resolved.pathname}${resolved.search}${resolved.hash}`;
  } catch {
    return '/';
  }
}
