import type { CodeRecord } from '../domain/token.js';
import type { Clock, Hasher, RandomSource } from './ports.js';
import { nowSeconds } from './ports.js';

/** In-memory, single-use authorization codes, keyed by their hash. */
export class AuthorizationCodes {
  private readonly codes = new Map<string, CodeRecord>();

  constructor(private readonly hasher: Hasher, private readonly random: RandomSource, private readonly clock: Clock) {}

  issue(record: Omit<CodeRecord, 'used' | 'familyId'>): string {
    this.prune();
    const code = this.random.token(32);
    this.codes.set(this.hasher.sha256Hex(code), { ...record, used: false });
    return code;
  }

  find(code: string | undefined): CodeRecord | undefined {
    return code ? this.codes.get(this.hasher.sha256Hex(code)) : undefined;
  }

  private prune(): void {
    const now = nowSeconds(this.clock);
    // Used codes are kept a little longer so a replay is still recognised.
    for (const [key, record] of this.codes) if (record.expiresAt + 600 <= now) this.codes.delete(key);
  }
}
