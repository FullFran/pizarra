import type { AuthSettings } from './settings.js';
import type { RandomSource, TicketSigner } from './ports.js';

const SESSION_PURPOSE = 'session';

export interface Session {
  login: string;
  sid: string;
}

/** Signed, stateless browser sessions; the allowlist is re-checked on every read. */
export class SessionService {
  constructor(private readonly settings: AuthSettings, private readonly signer: TicketSigner, private readonly random: RandomSource) {}

  issue(login: string): { value: string; maxAgeSeconds: number } {
    const ttl = this.settings.sessionTtlSeconds;
    return { value: this.signer.sign(SESSION_PURPOSE, { sub: login, sid: this.random.token(16) }, ttl), maxAgeSeconds: ttl };
  }

  read(value: string | undefined): Session | null {
    const payload = this.signer.verify<{ sub?: unknown; sid?: unknown }>(SESSION_PURPOSE, value);
    if (!payload || typeof payload.sub !== 'string' || typeof payload.sid !== 'string') return null;
    // Removing a login from the allowlist (and restarting) ends its sessions.
    if (!this.settings.allowedLogins.has(payload.sub)) return null;
    return { login: payload.sub, sid: payload.sid };
  }
}
