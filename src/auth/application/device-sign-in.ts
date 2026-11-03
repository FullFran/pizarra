import { MAX_PENDING_DEVICE_LOGINS, deviceLoginLifetimeSeconds, intervalAfterSlowDown } from '../domain/device-login.js';
import type { DeviceOutcome } from '../domain/device-login.js';
import { safeReturnPath } from '../domain/return-path.js';
import type { AuthSettings } from './settings.js';
import { IdentityUnavailableError } from './ports.js';
import type { Clock, GitHubIdentity, Logger, RandomSource, TicketSigner, TokenStore } from './ports.js';
import type { DeviceLoginRecord } from '../domain/token.js';

const DEVICE_PURPOSE = 'device-login';

export type StartResult =
  | { kind: 'started'; binding: string; lifetimeSeconds: number }
  | { kind: 'too_many' }
  | { kind: 'unavailable' };

export type ViewResult =
  | { kind: 'none' }
  | { kind: 'failed'; outcome: Exclude<DeviceOutcome, { kind: 'success' }> }
  | { kind: 'waiting'; userCode: string; verificationUri: string; intervalSeconds: number; expiresAt: number };

export type PollResult =
  | { kind: 'none' }
  | { kind: 'complete'; login: string; returnTo: string }
  | { kind: 'failed'; reason: string }
  | { kind: 'pending'; intervalSeconds: number };

/**
 * GitHub sign-in through the device flow (RFC 8628). The browser that starts
 * a login gets a sealed binding (a random nonce and GitHub's device code,
 * encrypted) for an HttpOnly, SameSite=Strict cookie; the rest of the login
 * is in the shared store, so any gateway can serve the next step. Only that browser can see
 * the code, poll and complete the login.
 */
export class DeviceSignIn {
  /** Polls in flight in this process, so concurrent requests share one GitHub call. */
  private readonly polling = new Map<string, Promise<void>>();

  constructor(
    private readonly settings: AuthSettings,
    private readonly github: GitHubIdentity,
    private readonly signer: TicketSigner,
    private readonly random: RandomSource,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly store: TokenStore
  ) {}

  async start(rawReturnTo: string | undefined): Promise<StartResult> {
    if (this.store.deviceLoginCount() >= MAX_PENDING_DEVICE_LOGINS) return { kind: 'too_many' };
    let device;
    try {
      device = await this.github.requestDeviceCode();
    } catch (error) {
      if (!(error instanceof IdentityUnavailableError)) throw error;
      this.logger.warn('GitHub device code request failed', { reason: error.message });
      return { kind: 'unavailable' };
    }
    const lifetimeSeconds = deviceLoginLifetimeSeconds(device.expiresInSeconds);
    const now = this.clock.nowMs();
    const nonce = this.random.token(24);
    this.store.putDeviceLogin(nonce, {
      userCode: device.userCode,
      verificationUri: device.verificationUri,
      expiresAt: now + lifetimeSeconds * 1000,
      intervalMs: device.intervalSeconds * 1000,
      // RFC 8628 §3.5: wait one interval before the first poll.
      nextPollAt: now + device.intervalSeconds * 1000,
      returnTo: safeReturnPath(rawReturnTo)
    });
    return { kind: 'started', binding: this.signer.seal(DEVICE_PURPOSE, { n: nonce, d: device.deviceCode }, lifetimeSeconds), lifetimeSeconds };
  }

  /** What the code page shows. A terminal failure is shown once, then forgotten. */
  view(binding: string | undefined): ViewResult {
    const found = this.find(binding);
    if (!found) return { kind: 'none' };
    const { nonce, record } = found;
    if (record.outcome && record.outcome.kind !== 'success') {
      this.store.deleteDeviceLogin(nonce);
      return { kind: 'failed', outcome: record.outcome };
    }
    return {
      kind: 'waiting',
      userCode: record.userCode,
      verificationUri: record.verificationUri,
      intervalSeconds: Math.ceil(record.intervalMs / 1000),
      expiresAt: record.expiresAt
    };
  }

  /** Advances the login (polling GitHub at most once per interval). */
  async poll(binding: string | undefined): Promise<PollResult> {
    const found = this.find(binding);
    if (!found) return { kind: 'none' };
    const { nonce } = found;
    await this.advance(nonce, found.deviceCode, found.record);
    const record = this.store.getDeviceLogin(nonce);
    if (!record) return { kind: 'none' };
    const outcome = record.outcome;
    if (outcome?.kind === 'success') {
      this.store.deleteDeviceLogin(nonce);
      return { kind: 'complete', login: outcome.login, returnTo: record.returnTo };
    }
    if (outcome) return { kind: 'failed', reason: outcome.kind };
    return { kind: 'pending', intervalSeconds: Math.ceil(record.intervalMs / 1000) };
  }

  private find(binding: string | undefined): { nonce: string; deviceCode: string; record: DeviceLoginRecord } | null {
    const payload = this.signer.open<{ n?: unknown; d?: unknown }>(DEVICE_PURPOSE, binding);
    if (!payload || typeof payload.n !== 'string' || typeof payload.d !== 'string') return null;
    const record = this.store.getDeviceLogin(payload.n);
    return record ? { nonce: payload.n, deviceCode: payload.d, record } : null;
  }

  private advance(nonce: string, deviceCode: string, record: DeviceLoginRecord): Promise<void> {
    const inFlight = this.polling.get(nonce);
    if (inFlight) return inFlight;
    if (record.outcome) return Promise.resolve();
    const now = this.clock.nowMs();
    if (now >= record.expiresAt) {
      this.store.updateDeviceLogin(nonce, current => (current.outcome ? undefined : { ...current, outcome: { kind: 'expired' } }));
      return Promise.resolve();
    }
    // Claim this poll atomically in the shared store: only one gateway calls
    // GitHub per interval; the others see the next poll time.
    const claimed = this.store.updateDeviceLogin(nonce, current =>
      current.outcome || now < current.nextPollAt ? undefined : { ...current, nextPollAt: now + current.intervalMs });
    if (!claimed) return Promise.resolve();
    const run = (async () => {
      const next: DeviceLoginRecord = { ...record };
      try {
        const result = await this.github.pollDeviceLogin(deviceCode);
        const after = this.clock.nowMs();
        switch (result.kind) {
          case 'pending':
            next.nextPollAt = after + next.intervalMs;
            break;
          case 'slow_down':
            next.intervalMs = intervalAfterSlowDown(next.intervalMs, result.intervalSeconds);
            next.nextPollAt = after + next.intervalMs;
            break;
          case 'expired':
            next.outcome = { kind: 'expired' };
            break;
          case 'denied':
            next.outcome = { kind: 'denied' };
            break;
          case 'error':
            this.logger.warn('GitHub device login failed', { reason: result.code });
            next.outcome = { kind: 'error' };
            break;
          case 'login':
            if (this.settings.allowedLogins.has(result.login)) {
              next.outcome = { kind: 'success', login: result.login };
            } else {
              this.logger.warn('GitHub login not in ALLOWED_GITHUB_LOGINS', { login: result.login });
              next.outcome = { kind: 'not_allowed', login: result.login };
            }
            break;
        }
      } catch (error) {
        if (!(error instanceof IdentityUnavailableError)) throw error;
        // GitHub unreachable: keep the login pending and try again later.
        this.logger.warn('GitHub device poll failed; will retry', { reason: error.message });
        next.nextPollAt = this.clock.nowMs() + next.intervalMs;
      } finally {
        this.polling.delete(nonce);
      }
      // Gone meanwhile (shown as failed, completed elsewhere or expired): leave it gone.
      // An outcome recorded meanwhile wins over this poll's result.
      this.store.updateDeviceLogin(nonce, current => (current.outcome ? undefined : { ...next, outcome: next.outcome }));
    })();
    this.polling.set(nonce, run);
    return run;
  }
}
