import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import type { RegisteredClient } from '../domain/client.js';
import type { RefreshTokenRecord, TokenRecord } from '../domain/token.js';
import type { Clock, RandomSource, TokenStore } from '../application/ports.js';
import { cryptoRandom, systemClock } from './node-crypto.js';

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
}

function emptyData(): StoreData {
  return { version: 1, clients: {}, accessTokens: {}, refreshTokens: {}, families: {} };
}

/**
 * Durable token store: one JSON file, written atomically with mode 0600.
 * Keys of the token maps are SHA-256 hashes; raw tokens and client secrets
 * are never written. The data is tiny (a few users and clients), so the
 * whole file is rewritten on every change. Same format as the fork's
 * `auth-store.json`, so an existing data volume keeps working.
 */
export class JsonFileTokenStore implements TokenStore {
  private data: StoreData;

  constructor(private readonly path: string, private readonly clock: Clock = systemClock, private readonly random: RandomSource = cryptoRandom) {
    this.data = this.load();
    this.prune();
  }

  private now(): number {
    return Math.floor(this.clock.nowMs() / 1000);
  }

  private load(): StoreData {
    if (!existsSync(this.path)) return emptyData();
    const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<StoreData>;
    if (parsed.version !== 1) throw new Error(`Unsupported auth store version in ${this.path}`);
    return { ...emptyData(), ...parsed, version: 1 };
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.${this.random.token(6)}.tmp`;
    const descriptor = openSync(temporary, 'wx', 0o600);
    try {
      writeSync(descriptor, JSON.stringify(this.data));
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    try {
      renameSync(temporary, this.path);
    } catch (error) {
      try { unlinkSync(temporary); } catch { /* already gone */ }
      throw error;
    }
    chmodSync(this.path, 0o600);
  }

  private prune(): void {
    const now = this.now();
    for (const [key, record] of Object.entries(this.data.accessTokens)) if (record.expiresAt <= now) delete this.data.accessTokens[key];
    for (const [key, record] of Object.entries(this.data.refreshTokens)) if (record.expiresAt <= now) delete this.data.refreshTokens[key];
    for (const [key, record] of Object.entries(this.data.families)) if (record.expiresAt <= now) delete this.data.families[key];
  }

  clientCount(): number {
    return Object.keys(this.data.clients).length;
  }

  getClient(clientId: string): RegisteredClient | undefined {
    return Object.prototype.hasOwnProperty.call(this.data.clients, clientId) ? this.data.clients[clientId] : undefined;
  }

  addClient(client: RegisteredClient): void {
    this.data.clients[client.clientId] = client;
    this.save();
  }

  createFamily(expiresAt: number): string {
    const id = this.random.token(16);
    this.data.families[id] = { expiresAt };
    return id;
  }

  isFamilyActive(familyId: string): boolean {
    const family = this.data.families[familyId];
    return Boolean(family && !family.revokedAt && family.expiresAt > this.now());
  }

  extendFamily(familyId: string, expiresAt: number): void {
    const family = this.data.families[familyId];
    if (family) family.expiresAt = Math.max(family.expiresAt, expiresAt);
  }

  revokeFamily(familyId: string): void {
    const family = this.data.families[familyId];
    if (family) family.revokedAt = this.now();
    for (const [key, record] of Object.entries(this.data.accessTokens)) if (record.familyId === familyId) delete this.data.accessTokens[key];
    for (const record of Object.values(this.data.refreshTokens)) if (record.familyId === familyId) record.usedAt ??= this.now();
    this.save();
  }

  putTokens(access: { hash: string; record: TokenRecord }, refresh: { hash: string; record: RefreshTokenRecord }): void {
    this.prune();
    this.data.accessTokens[access.hash] = access.record;
    this.data.refreshTokens[refresh.hash] = refresh.record;
    this.save();
  }

  getAccessToken(hash: string): TokenRecord | undefined {
    const record = this.data.accessTokens[hash];
    if (!record) return undefined;
    if (record.expiresAt <= this.now() || !this.isFamilyActive(record.familyId)) return undefined;
    return record;
  }

  getRefreshToken(hash: string): RefreshTokenRecord | undefined {
    const record = this.data.refreshTokens[hash];
    if (!record || record.expiresAt <= this.now()) return undefined;
    return record;
  }

  markRefreshTokenUsed(hash: string): void {
    const record = this.data.refreshTokens[hash];
    if (record) record.usedAt = this.now();
  }
}
