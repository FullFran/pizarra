import type { CodeRecord } from '../domain/token.js';
import type { Hasher, RandomSource, TokenStore } from './ports.js';

/**
 * Single-use authorization codes, kept by hash in the shared store so a code
 * issued by one gateway can be redeemed on another, and burnt only once.
 */
export class AuthorizationCodes {
  constructor(private readonly store: TokenStore, private readonly hasher: Hasher, private readonly random: RandomSource) {}

  issue(record: Omit<CodeRecord, 'used' | 'familyId'>): string {
    const code = this.random.token(32);
    this.store.putCode(this.hasher.sha256Hex(code), { ...record, used: false });
    return code;
  }

  /**
   * Burns the code for this client and returns it as it was before burning
   * (`used` tells a replay). Undefined when unknown or issued to another
   * client, which leaves it untouched.
   */
  redeem(code: string | undefined, clientId: string): CodeRecord | undefined {
    return code ? this.store.useCode(this.hasher.sha256Hex(code), clientId) : undefined;
  }

  /** Records which token family the code issued, so a later replay revokes it. */
  issued(code: string, familyId: string): void {
    this.store.setCodeFamily(this.hasher.sha256Hex(code), familyId);
  }
}
