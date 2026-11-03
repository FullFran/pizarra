// Fake ports for application tests: deterministic clock, counter-based
// randomness, an in-memory token store and scripted GitHub / metadata fetchers.
import { createHash } from 'node:crypto';
import { HmacTicketSigner } from '../../dist/auth/infrastructure/node-crypto.js';
import { Allowlist } from '../../dist/auth/domain/allowlist.js';

export function fakeClock(start = 1_700_000_000_000) {
  let now = start;
  return { nowMs: () => now, advance: ms => { now += ms; } };
}

export function fakeRandom() {
  let n = 0;
  return { token: () => `tok${++n}`.padEnd(12, 'x') };
}

export const hasher = {
  sha256Hex: v => createHash('sha256').update(v).digest('hex'),
  sha256Base64Url: v => createHash('sha256').update(v, 'ascii').digest('base64url'),
  constantTimeEqual: (a, b) => a === b
};

export const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

export function signer(clock) {
  return new HmacTicketSigner(Buffer.from('x'.repeat(40)), clock);
}

export function settings(overrides = {}) {
  return {
    issuer: 'https://board.example',
    resources: ['https://board.example/mcp'],
    allowedLogins: new Allowlist(['FullFran']),
    accessTokenTtlSeconds: 3600,
    refreshTokenTtlSeconds: 86400,
    sessionTtlSeconds: 3600,
    authorizationCodeTtlSeconds: 60,
    ...overrides
  };
}

export function memoryStore(clock) {
  const clients = new Map();
  const access = new Map();
  const refresh = new Map();
  const families = new Map();
  let n = 0;
  const now = () => Math.floor(clock.nowMs() / 1000);
  const store = {
    clientCount: () => clients.size,
    getClient: id => clients.get(id),
    addClient: client => { clients.set(client.clientId, client); },
    createFamily: expiresAt => { const id = `fam${++n}`; families.set(id, { expiresAt }); return id; },
    isFamilyActive: id => { const f = families.get(id); return Boolean(f && !f.revokedAt && f.expiresAt > now()); },
    extendFamily: (id, expiresAt) => { const f = families.get(id); if (f) f.expiresAt = Math.max(f.expiresAt, expiresAt); },
    revokeFamily: id => {
      const f = families.get(id); if (f) f.revokedAt = now();
      for (const [k, r] of access) if (r.familyId === id) access.delete(k);
      for (const r of refresh.values()) if (r.familyId === id) r.usedAt ??= now();
    },
    putTokens: (a, r) => { access.set(a.hash, a.record); refresh.set(r.hash, r.record); },
    getAccessToken: hash => { const r = access.get(hash); return r && r.expiresAt > now() && store.isFamilyActive(r.familyId) ? r : undefined; },
    getRefreshToken: hash => { const r = refresh.get(hash); return r && r.expiresAt > now() ? r : undefined; },
    markRefreshTokenUsed: hash => { const r = refresh.get(hash); if (r) r.usedAt = now(); }
  };
  return store;
}

export function scriptedMetadata(documents) {
  const calls = [];
  return {
    calls,
    fetch: async url => {
      calls.push(url);
      const doc = documents[url];
      if (!doc) return { status: 404, body: '{}' };
      return { status: 200, cacheControl: 'max-age=120', body: JSON.stringify(doc) };
    }
  };
}

export function scriptedGitHub() {
  const state = { polls: 0, next: [{ kind: 'pending' }], requests: 0, fail: false };
  return {
    state,
    requestDeviceCode: async () => {
      state.requests += 1;
      return { deviceCode: `dev${state.requests}`, userCode: 'ABCD-EFGH', verificationUri: 'https://github.com/login/device', expiresInSeconds: 900, intervalSeconds: 5 };
    },
    pollDeviceLogin: async () => {
      state.polls += 1;
      return state.next.length > 1 ? state.next.shift() : state.next[0];
    }
  };
}
