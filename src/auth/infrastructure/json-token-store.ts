import type { RegisteredClient } from '../domain/client.js';
import type { CodeRecord, DeviceLoginRecord, RefreshTokenRecord, TokenRecord } from '../domain/token.js';
import type { Clock, RandomSource, TokenStore } from '../application/ports.js';
import { cryptoRandom, systemClock } from './node-crypto.js';
import { LockedJsonFile } from '../../shared/locked-json-file.js';

interface FamilyRecord {
  expiresAt: number;
  revokedAt?: number;
}

interface StoreData {
  version: 1;
  clients: Record<string, RegisteredClient>;
  accessTokens: Record<string, TokenRecord>;
  refreshTokens: Record<string, RefreshTokenRecord>;
  families: Record<string, FamilyRecord>;
  /** Authorization codes by hash. */
  codes: Record<string, CodeRecord>;
  /** Single-use keys (consent tickets) and when they may be forgotten, seconds. */
  usedOnce: Record<string, number>;
  /** GitHub device logins by the nonce in the browser's binding cookie. */
  deviceLogins: Record<string, DeviceLoginRecord>;
}

function emptyData(): StoreData {
  return { version: 1, clients: {}, accessTokens: {}, refreshTokens: {}, families: {}, codes: {}, usedOnce: {}, deviceLogins: {} };
}

/** Used codes are kept a little longer so a replay is still recognised. */
const USED_CODE_GRACE_SECONDS = 600;
/** A family revoked before it was created (a replay won the race) is remembered this long. */
const REVOKED_FAMILY_TOMBSTONE_SECONDS = 86_400;

function own<T>(map: Record<string, T>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

/**
 * Durable auth state: one JSON file, written atomically with mode 0600. Keys
 * of the token and code maps are SHA-256 hashes; raw tokens, codes and
 * client secrets are never written. The data is tiny (a few users and
 * clients), so the whole file is rewritten on every change. Same format as
 * the fork's `auth-store.json` (version 1, new maps optional), so an existing
 * data volume keeps working.
 *
 * Several gateways may share the file (two containers during a blue-green
 * deploy). Reads re-load the file when it changed on disk. Every change is
 * a transaction: take a lock directory next to the file (mkdir is atomic
 * across processes and containers on one host) holding the owner's token,
 * re-load, change, write, release only if still the owner. A lock left by a
 * process that died (older than 10 s) is broken under a separate break
 * mutex, so only one waiter removes it. Single-use operations (codes, refresh tokens, tickets) decide
 * inside that transaction, so only one gateway can win them.
 */
export class JsonFileTokenStore implements TokenStore {
  private readonly file: LockedJsonFile<StoreData>;

  constructor(private readonly path: string, private readonly clock: Clock = systemClock, private readonly random: RandomSource = cryptoRandom) {
    this.file = new LockedJsonFile<StoreData>(path, {
      empty: emptyData,
      parse: (raw, file) => {
        const parsed = raw as Partial<StoreData>;
        if (parsed.version !== 1) throw new Error(`Unsupported auth store version in ${file}`);
        return { ...emptyData(), ...parsed, version: 1 };
      },
      token: bytes => this.random.token(bytes)
    });
  }

  private now(): number {
    return Math.floor(this.clock.nowMs() / 1000);
  }

  /** Runs `change` on the current file contents under the lock, then writes the result. */
  private transact<T>(change: (data: StoreData) => T): T {
    return this.file.transact(change, data => this.prune(data));
  }

  private prune(data: StoreData): void {
    const now = this.now();
    const nowMs = this.clock.nowMs();
    for (const [key, record] of Object.entries(data.accessTokens)) if (record.expiresAt <= now) delete data.accessTokens[key];
    for (const [key, record] of Object.entries(data.refreshTokens)) if (record.expiresAt <= now) delete data.refreshTokens[key];
    for (const [key, record] of Object.entries(data.families)) if (record.expiresAt <= now) delete data.families[key];
    for (const [key, record] of Object.entries(data.codes)) if (record.expiresAt + USED_CODE_GRACE_SECONDS <= now) delete data.codes[key];
    for (const [key, expiresAt] of Object.entries(data.usedOnce)) if (expiresAt <= now) delete data.usedOnce[key];
    for (const [key, record] of Object.entries(data.deviceLogins)) if (record.expiresAt <= nowMs) delete data.deviceLogins[key];
  }

  private read(): StoreData {
    return this.file.read();
  }

  clientCount(): number {
    return Object.keys(this.read().clients).length;
  }

  getClient(clientId: string): RegisteredClient | undefined {
    return own(this.read().clients, clientId);
  }

  addClient(client: RegisteredClient): void {
    this.transact(data => { data.clients[client.clientId] = client; });
  }

  createFamily(expiresAt: number, id: string = this.random.token(16)): string {
    this.transact(data => {
      const existing = own(data.families, id);
      // A family revoked before it existed (a replay won the race) stays revoked.
      data.families[id] = existing ? { ...existing, expiresAt: Math.max(existing.expiresAt, expiresAt) } : { expiresAt };
    });
    return id;
  }

  isFamilyActive(familyId: string): boolean {
    const family = own(this.read().families, familyId);
    return Boolean(family && !family.revokedAt && family.expiresAt > this.now());
  }

  extendFamily(familyId: string, expiresAt: number): void {
    this.transact(data => {
      const family = own(data.families, familyId);
      if (family) family.expiresAt = Math.max(family.expiresAt, expiresAt);
    });
  }

  revokeFamily(familyId: string): void {
    this.transact(data => {
      const now = this.now();
      const family = own(data.families, familyId);
      if (family) family.revokedAt = now;
      else data.families[familyId] = { expiresAt: now + REVOKED_FAMILY_TOMBSTONE_SECONDS, revokedAt: now };
      for (const [key, record] of Object.entries(data.accessTokens)) if (record.familyId === familyId) delete data.accessTokens[key];
      for (const record of Object.values(data.refreshTokens)) if (record.familyId === familyId) record.usedAt ??= now;
    });
  }

  putTokens(access: { hash: string; record: TokenRecord }, refresh: { hash: string; record: RefreshTokenRecord }): void {
    this.transact(data => {
      data.accessTokens[access.hash] = access.record;
      data.refreshTokens[refresh.hash] = refresh.record;
    });
  }

  getAccessToken(hash: string): TokenRecord | undefined {
    const record = own(this.read().accessTokens, hash);
    if (!record) return undefined;
    if (record.expiresAt <= this.now() || !this.isFamilyActive(record.familyId)) return undefined;
    return record;
  }

  getRefreshToken(hash: string): RefreshTokenRecord | undefined {
    const record = own(this.read().refreshTokens, hash);
    if (!record || record.expiresAt <= this.now()) return undefined;
    return record;
  }

  markRefreshTokenUsed(hash: string): boolean {
    return this.transact(data => {
      const record = own(data.refreshTokens, hash);
      if (!record || record.usedAt !== undefined) return false;
      record.usedAt = this.now();
      return true;
    });
  }

  putCode(hash: string, record: CodeRecord): void {
    this.transact(data => { data.codes[hash] = record; });
  }

  useCode(hash: string, clientId: string): CodeRecord | undefined {
    return this.transact(data => {
      const record = own(data.codes, hash);
      if (!record || record.clientId !== clientId) return undefined;
      const before = { ...record };
      if (!record.used) {
        // The family is fixed when the code burns, so a replay on another
        // gateway can revoke it even before its tokens exist.
        record.familyId = this.random.token(16);
        before.familyId = record.familyId;
      }
      record.used = true;
      return before;
    });
  }

  updateDeviceLogin(nonce: string, change: (record: DeviceLoginRecord) => DeviceLoginRecord | undefined): DeviceLoginRecord | undefined {
    return this.transact(data => {
      const record = own(data.deviceLogins, nonce);
      if (!record || record.expiresAt <= this.clock.nowMs()) return undefined;
      const next = change({ ...record });
      if (next) data.deviceLogins[nonce] = next;
      return next;
    });
  }

  claimOnce(key: string, expiresAt: number): boolean {
    return this.transact(data => {
      if (own(data.usedOnce, key) !== undefined) return false;
      data.usedOnce[key] = expiresAt;
      return true;
    });
  }

  deviceLoginCount(): number {
    const nowMs = this.clock.nowMs();
    return Object.values(this.read().deviceLogins).filter(record => record.expiresAt > nowMs).length;
  }

  getDeviceLogin(nonce: string): DeviceLoginRecord | undefined {
    const record = own(this.read().deviceLogins, nonce);
    return record && record.expiresAt > this.clock.nowMs() ? { ...record } : undefined;
  }

  putDeviceLogin(nonce: string, record: DeviceLoginRecord): void {
    this.transact(data => { data.deviceLogins[nonce] = record; });
  }

  deleteDeviceLogin(nonce: string): void {
    this.transact(data => { delete data.deviceLogins[nonce]; });
  }
}
