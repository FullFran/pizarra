import type { AuthSettings } from './settings.js';
import type { RandomSource, TicketSigner } from './ports.js';
import { StaticAccessPolicy } from './identity.js';
import type { AccessPolicy } from './identity.js';

const SESSION_PURPOSE = 'session';

export interface Session {
  login: string;
  sid: string;
}

/** Signed, stateless browser sessions; who may sign in is re-checked on every read. */
export class SessionService {
  constructor(
    private readonly settings: AuthSettings,
    private readonly signer: TicketSigner,
    private readonly random: RandomSource,
    private readonly policy: AccessPolicy = new StaticAccessPolicy(settings)
  ) {}

  issue(login: string): { value: string; maxAgeSeconds: number } {
    const ttl = this.settings.sessionTtlSeconds;
    return { value: this.signer.sign(SESSION_PURPOSE, { sub: login, sid: this.random.token(16) }, ttl), maxAgeSeconds: ttl };
  }

  read(value: string | undefined): Session | null {
    const payload = this.signer.verify<{ sub?: unknown; sid?: unknown }>(SESSION_PURPOSE, value);
    if (!payload || typeof payload.sub !== 'string' || typeof payload.sid !== 'string') return null;
    // Removing a login from the allowlist (and restarting), or its last
    // board membership, ends its sessions.
    if (!this.policy.maySignIn(payload.sub)) return null;
    return { login: payload.sub, sid: payload.sid };
  }
}
