import { MAX_PENDING_DEVICE_LOGINS, deviceLoginLifetimeSeconds, intervalAfterSlowDown } from '../domain/device-login.js';
import type { DeviceOutcome } from '../domain/device-login.js';
import { safeReturnPath } from '../domain/return-path.js';
import type { AuthSettings } from './settings.js';
import { IdentityUnavailableError } from './ports.js';
import type { Clock, GitHubIdentity, Logger, RandomSource, TicketSigner } from './ports.js';

const DEVICE_PURPOSE = 'device-login';

/** A GitHub device login, reachable only through its browser's binding cookie. */
interface DeviceLogin {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  intervalMs: number;
  nextPollAt: number;
  returnTo: string;
  outcome?: DeviceOutcome;
  polling?: Promise<void> | undefined;
}

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
 * a login gets a signed binding (a random nonce) for an HttpOnly,
 * SameSite=Strict cookie; the device code stays in this map. Only that
 * browser can see the code, poll and complete the login.
 */
export class DeviceSignIn {
  private readonly logins = new Map<string, DeviceLogin>();

  constructor(
    private readonly settings: AuthSettings,
    private readonly github: GitHubIdentity,
    private readonly signer: TicketSigner,
    private readonly random: RandomSource,
    private readonly clock: Clock,
    private readonly logger: Logger
  ) {}

  async start(rawReturnTo: string | undefined): Promise<StartResult> {
    this.prune();
    if (this.logins.size >= MAX_PENDING_DEVICE_LOGINS) return { kind: 'too_many' };
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
    this.logins.set(nonce, {
      deviceCode: device.deviceCode,
      userCode: device.userCode,
      verificationUri: device.verificationUri,
      expiresAt: now + lifetimeSeconds * 1000,
      intervalMs: device.intervalSeconds * 1000,
      // RFC 8628 §3.5: wait one interval before the first poll.
      nextPollAt: now + device.intervalSeconds * 1000,
      returnTo: safeReturnPath(rawReturnTo)
    });
    return { kind: 'started', binding: this.signer.sign(DEVICE_PURPOSE, { n: nonce }, lifetimeSeconds), lifetimeSeconds };
  }

  /** What the code page shows. A terminal failure is shown once, then forgotten. */
  view(binding: string | undefined): ViewResult {
    const found = this.find(binding);
    if (!found) return { kind: 'none' };
    const { nonce, record } = found;
    if (record.outcome && record.outcome.kind !== 'success') {
      this.logins.delete(nonce);
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
    const { nonce, record } = found;
    await this.advance(record);
    const outcome = record.outcome;
    if (outcome?.kind === 'success') {
      this.logins.delete(nonce);
      return { kind: 'complete', login: outcome.login, returnTo: record.returnTo };
    }
    if (outcome) return { kind: 'failed', reason: outcome.kind };
    return { kind: 'pending', intervalSeconds: Math.ceil(record.intervalMs / 1000) };
  }

  private prune(): void {
    const now = this.clock.nowMs();
    for (const [nonce, record] of this.logins) if (record.expiresAt <= now) this.logins.delete(nonce);
  }

  private find(binding: string | undefined): { nonce: string; record: DeviceLogin } | null {
    this.prune();
    const payload = this.signer.verify<{ n?: unknown }>(DEVICE_PURPOSE, binding);
    if (!payload || typeof payload.n !== 'string') return null;
    const record = this.logins.get(payload.n);
    return record ? { nonce: payload.n, record } : null;
  }

  private async advance(record: DeviceLogin): Promise<void> {
    if (record.outcome) return;
    if (record.polling) return record.polling;
    const now = this.clock.nowMs();
    if (now >= record.expiresAt) {
      record.outcome = { kind: 'expired' };
      return;
    }
    if (now < record.nextPollAt) return;
    record.polling = (async () => {
      try {
        const result = await this.github.pollDeviceLogin(record.deviceCode);
        const after = this.clock.nowMs();
        switch (result.kind) {
          case 'pending':
            record.nextPollAt = after + record.intervalMs;
            break;
          case 'slow_down':
            record.intervalMs = intervalAfterSlowDown(record.intervalMs, result.intervalSeconds);
            record.nextPollAt = after + record.intervalMs;
            break;
          case 'expired':
            record.outcome = { kind: 'expired' };
            break;
          case 'denied':
            record.outcome = { kind: 'denied' };
            break;
          case 'error':
            this.logger.warn('GitHub device login failed', { reason: result.code });
            record.outcome = { kind: 'error' };
            break;
          case 'login':
            if (this.settings.allowedLogins.has(result.login)) {
              record.outcome = { kind: 'success', login: result.login };
            } else {
              this.logger.warn('GitHub login not in ALLOWED_GITHUB_LOGINS', { login: result.login });
              record.outcome = { kind: 'not_allowed', login: result.login };
            }
            break;
        }
      } catch (error) {
        if (!(error instanceof IdentityUnavailableError)) throw error;
        // GitHub unreachable: keep the login pending and try again later.
        this.logger.warn('GitHub device poll failed; will retry', { reason: error.message });
        record.nextPollAt = this.clock.nowMs() + record.intervalMs;
      } finally {
        record.polling = undefined;
      }
    })();
    return record.polling;
  }
}
