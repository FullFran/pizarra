// Two gateways on one /data (blue-green deploys): every piece of auth state they must share goes
// through /data/auth-store.json. Two JsonFileTokenStore instances on the same file stand for the
// two containers; the last test uses real child processes for the cross-process lock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, statSync, utimesSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { JsonFileTokenStore } from '../../dist/auth/infrastructure/json-token-store.js';

const STORE_MODULE = fileURLToPath(new URL('../../dist/auth/infrastructure/json-token-store.js', import.meta.url));

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pizarra-store-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'auth-store.json');
}

const clock = { nowMs: () => 1_800_000_000_000 };
const now = Math.floor(clock.nowMs() / 1000);
const client = id => ({ clientId: id, clientName: id, redirectUris: ['http://127.0.0.1/cb'], tokenEndpointAuthMethod: 'none', registeredAt: now });
const token = (familyId, extra = {}) => ({ clientId: 'c', login: 'fran', scope: 'mcp', resource: 'https://p.example/mcp', expiresAt: now + 3600, familyId, ...extra });
const code = (extra = {}) => ({
  clientId: 'c', redirectUri: 'http://127.0.0.1/cb', codeChallenge: 'x', scope: 'mcp', resource: 'r', login: 'fran',
  expiresAt: now + 60, used: false, ...extra
});
const deviceLogin = (extra = {}) => ({
  userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device',
  expiresAt: clock.nowMs() + 600_000, intervalMs: 5000, nextPollAt: clock.nowMs() + 5000, returnTo: '/', ...extra
});

test('a client registered on one copy is known on the other', t => {
  const path = scratch(t);
  const a = new JsonFileTokenStore(path, clock);
  const b = new JsonFileTokenStore(path, clock);
  a.addClient(client('from-a'));
  assert.equal(b.getClient('from-a')?.clientId, 'from-a');
  assert.equal(b.clientCount(), 1);
});

test('writes from both copies are merged, never lost', t => {
  const path = scratch(t);
  const a = new JsonFileTokenStore(path, clock);
  const b = new JsonFileTokenStore(path, clock);
  a.addClient(client('one'));
  b.addClient(client('two'));
  a.addClient(client('three'));
  const fresh = new JsonFileTokenStore(path, clock);
  assert.deepEqual(['one', 'two', 'three'].map(id => fresh.getClient(id)?.clientId), ['one', 'two', 'three']);
});

test('tokens issued on one copy authenticate on the other, and a revocation reaches both', t => {
  const path = scratch(t);
  const a = new JsonFileTokenStore(path, clock);
  const b = new JsonFileTokenStore(path, clock);
  const family = a.createFamily(now + 7200);
  a.putTokens({ hash: 'acc', record: token(family) }, { hash: 'ref', record: token(family) });
  assert.equal(b.getAccessToken('acc')?.login, 'fran');
  assert.equal(b.isFamilyActive(family), true);
  b.revokeFamily(family);
  assert.equal(a.getAccessToken('acc'), undefined);
  assert.equal(a.isFamilyActive(family), false);
});

test('a family created on one copy survives a write from the other', t => {
  const path = scratch(t);
  const a = new JsonFileTokenStore(path, clock);
  const b = new JsonFileTokenStore(path, clock);
  const family = a.createFamily(now + 7200);
  b.addClient(client('other'));
  a.extendFamily(family, now + 9000);
  assert.equal(new JsonFileTokenStore(path, clock).isFamilyActive(family), true);
});

test('an authorization code is single use across copies', t => {
  const path = scratch(t);
  const a = new JsonFileTokenStore(path, clock);
  const b = new JsonFileTokenStore(path, clock);
  a.putCode('h1', code());
  assert.equal(b.useCode('h1', 'other-client'), undefined, 'another client neither sees nor burns the code');
  const first = b.useCode('h1', 'c');
  assert.equal(first?.used, false, 'first presentation sees an unused code');
  const second = a.useCode('h1', 'c');
  assert.equal(second?.used, true, 'second presentation, on the other copy, sees it used');
  assert.equal(second?.familyId, first.familyId, 'and knows which family to revoke');
  assert.equal(a.useCode('missing', 'c'), undefined);
});

test('a refresh token can be marked used only once across copies', t => {
  const path = scratch(t);
  const a = new JsonFileTokenStore(path, clock);
  const b = new JsonFileTokenStore(path, clock);
  const family = a.createFamily(now + 7200);
  a.putTokens({ hash: 'acc', record: token(family) }, { hash: 'ref', record: token(family) });
  assert.equal(b.markRefreshTokenUsed('ref'), true);
  assert.equal(a.markRefreshTokenUsed('ref'), false);
  assert.notEqual(a.getRefreshToken('ref')?.usedAt, undefined);
});

test('a consent ticket can be claimed only once across copies', t => {
  const path = scratch(t);
  const a = new JsonFileTokenStore(path, clock);
  const b = new JsonFileTokenStore(path, clock);
  assert.equal(a.claimOnce('ticket-1', now + 300), true);
  assert.equal(b.claimOnce('ticket-1', now + 300), false);
  assert.equal(b.claimOnce('ticket-2', now + 300), true);
});

test('a device login started on one copy is found, updated and deleted on the other', t => {
  const path = scratch(t);
  const a = new JsonFileTokenStore(path, clock);
  const b = new JsonFileTokenStore(path, clock);
  a.putDeviceLogin('n1', deviceLogin());
  assert.equal(b.deviceLoginCount(), 1);
  assert.equal(b.getDeviceLogin('n1')?.userCode, 'ABCD-1234');
  b.putDeviceLogin('n1', deviceLogin({ outcome: { kind: 'denied' } }));
  assert.deepEqual(a.getDeviceLogin('n1')?.outcome, { kind: 'denied' });
  a.deleteDeviceLogin('n1');
  assert.equal(b.getDeviceLogin('n1'), undefined);
});

test('expired codes, tickets and device logins are pruned', t => {
  const path = scratch(t);
  let ms = clock.nowMs();
  const moving = { nowMs: () => ms };
  const store = new JsonFileTokenStore(path, moving);
  store.putCode('h', code());
  store.claimOnce('tk', now + 10);
  store.putDeviceLogin('n', deviceLogin());
  ms += 3600_000;
  store.addClient(client('trigger-a-write'));
  const data = JSON.parse(readFileSync(path, 'utf8'));
  assert.deepEqual([Object.keys(data.codes), Object.keys(data.usedOnce), Object.keys(data.deviceLogins)], [[], [], []]);
});

test('the store stays mode 0600, never holds raw codes, and reads an existing version 1 file', t => {
  const path = scratch(t);
  writeFileSync(path, JSON.stringify({ version: 1, clients: { old: client('old') }, accessTokens: {}, refreshTokens: {}, families: {} }), { mode: 0o600 });
  const store = new JsonFileTokenStore(path, clock);
  assert.equal(store.getClient('old')?.clientId, 'old');
  store.putCode('sha256-of-code', code());
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(path, 'utf8')).codes), ['sha256-of-code']);
});

test('a lock left by a crashed process is broken after it goes stale', t => {
  const path = scratch(t);
  mkdirSync(`${path}.lock`);
  const old = new Date(Date.now() - 60_000);
  utimesSync(`${path}.lock`, old, old);
  const store = new JsonFileTokenStore(path, clock);
  store.addClient(client('after-crash'));
  assert.equal(new JsonFileTokenStore(path, clock).getClient('after-crash')?.clientId, 'after-crash');
});

test('concurrent writers in separate processes lose nothing', async t => {
  const path = scratch(t);
  const writers = 4;
  const each = 25;
  const script = `
    const { JsonFileTokenStore } = await import(${JSON.stringify(STORE_MODULE)});
    const store = new JsonFileTokenStore(${JSON.stringify(path)});
    const w = process.argv[1];
    for (let i = 0; i < ${each}; i++) {
      store.addClient({ clientId: w + '-' + i, clientName: 'x', redirectUris: ['http://127.0.0.1/cb'], tokenEndpointAuthMethod: 'none', registeredAt: 1 });
    }`;
  const runs = Array.from({ length: writers }, (_, w) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, `w${w}`], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', d => { err += d; });
    child.on('exit', code => (code === 0 ? resolve() : reject(new Error(`writer ${w} exited ${code}: ${err}`))));
  }));
  await Promise.all(runs);
  assert.equal(new JsonFileTokenStore(path, clock).clientCount(), writers * each);
});

test('breaking a stale lock lets exactly one process in (single use stays exact after a crash)', async t => {
  const path = scratch(t);
  const racers = 6;
  const rounds = 8;
  const script = `
    const { JsonFileTokenStore } = await import(${JSON.stringify(STORE_MODULE)});
    const store = new JsonFileTokenStore(${JSON.stringify(path)});
    const key = process.argv[1];
    while (Date.now() < Number(process.argv[2])) {}
    process.stdout.write(store.claimOnce(key, 4102444800) ? 'won' : 'lost');`;
  for (let round = 0; round < rounds; round++) {
    // A holder that died: its lock directory is left behind, long stale.
    mkdirSync(`${path}.lock`, { recursive: true });
    const old = new Date(Date.now() - 60_000);
    utimesSync(`${path}.lock`, old, old);
    const start = Date.now() + 400;
    const results = await Promise.all(Array.from({ length: racers }, () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script, `k${round}`, String(start)], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      child.stdout.on('data', d => { out += d; });
      child.stderr.on('data', d => { err += d; });
      child.on('exit', code => (code === 0 ? resolve(out) : reject(new Error(`racer exited ${code}: ${err}`))));
    })));
    assert.equal(results.filter(r => r === 'won').length, 1, `round ${round}: ${results.join(',')}`);
  }
});

test('a replay that lands between redeeming a code and issuing its tokens still revokes them', t => {
  const path = scratch(t);
  const a = new JsonFileTokenStore(path, clock);
  const b = new JsonFileTokenStore(path, clock);
  a.putCode('h', code());
  const first = a.useCode('h', 'c');
  assert.equal(first?.used, false);
  assert.ok(first?.familyId, 'the family is chosen when the code is burnt');
  const replay = b.useCode('h', 'c');
  assert.equal(replay?.familyId, first.familyId, 'the replay on the other copy knows the family');
  b.revokeFamily(replay.familyId);
  a.createFamily(now + 7200, first.familyId);
  a.putTokens({ hash: 'acc', record: token(first.familyId) }, { hash: 'ref', record: token(first.familyId) });
  assert.equal(a.isFamilyActive(first.familyId), false, 'a family revoked before it was created stays revoked');
  assert.equal(b.getAccessToken('acc'), undefined);
});
