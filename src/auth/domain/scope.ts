/** The single OAuth scope this authorization server issues and requires. */
export const WHITEBOARD_SCOPE = 'whiteboard';

/** Space-separated scope string to its scopes; empty means the default scope. */
export function requestedScopes(raw: string | undefined): string[] {
  const value = raw?.trim();
  return value ? value.split(/\s+/) : [WHITEBOARD_SCOPE];
}

export function onlyKnownScopes(scopes: string[]): boolean {
  return scopes.every(scope => scope === WHITEBOARD_SCOPE);
}

/** Whether every requested scope is part of the original grant. */
export function withinGrant(requested: string | undefined, granted: string): boolean {
  const value = requested?.trim();
  if (!value) return true;
  const grantedScopes = granted.split(' ');
  return value.split(/\s+/).every(scope => grantedScopes.includes(scope));
}
