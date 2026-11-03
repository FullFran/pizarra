/** Device codes live as long as GitHub says, but never longer than this. */
export const MAX_DEVICE_LOGIN_SECONDS = 15 * 60;
/** Device logins waiting for GitHub at once, across all clients. */
export const MAX_PENDING_DEVICE_LOGINS = 20;

export type DeviceOutcome =
  | { kind: 'success'; login: string }
  | { kind: 'not_allowed'; login: string }
  | { kind: 'expired' }
  | { kind: 'denied' }
  | { kind: 'error' };

/** RFC 8628 §3.5: after slow_down add 5 s, or use the new interval if larger. */
export function intervalAfterSlowDown(currentMs: number, suggestedSeconds: number | undefined): number {
  return Math.max(currentMs + 5000, (suggestedSeconds ?? 0) * 1000);
}

export function deviceLoginLifetimeSeconds(expiresInSeconds: number): number {
  return Math.min(expiresInSeconds, MAX_DEVICE_LOGIN_SECONDS);
}
