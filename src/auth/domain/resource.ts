export type ResourceChoice = { ok: true; resource: string } | { ok: false };

/**
 * RFC 8707: picks the protected resource a grant is for. `resource` may be
 * omitted only when exactly one resource is configured; when given (once) it
 * must be one of them.
 */
export function chooseResource(requested: unknown, configured: readonly string[]): ResourceChoice {
  const values = requested === undefined ? [] : [requested].flat();
  if (values.length > 1) return { ok: false };
  if (values.length === 0) return configured.length === 1 ? { ok: true, resource: configured[0]! } : { ok: false };
  const value = values[0];
  return typeof value === 'string' && configured.includes(value) ? { ok: true, resource: value } : { ok: false };
}
