import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { AuthorizationCodes } from '../../dist/auth/application/authorization-codes.js';
import { AuthorizationService } from '../../dist/auth/application/authorize.js';
import { ClientRegistry } from '../../dist/auth/application/clients.js';
import { DeviceSignIn } from '../../dist/auth/application/device-sign-in.js';
import { SessionService } from '../../dist/auth/application/sessions.js';
import { TokenService } from '../../dist/auth/application/tokens.js';
import { AccessTokenVerifier } from '../../dist/auth/application/access-tokens.js';
import { AccessGate } from '../../dist/gateway/application/access-gate.js';
import { HmacTicketSigner } from '../../dist/auth/infrastructure/node-crypto.js';
import { fakeClock, fakeRandom, hasher, memoryStore, scriptedGitHub, scriptedMetadata, settings, signer, silentLogger } from './fakes.mjs';

const CIMD_ID = 'https://app.example/client.json';

function world() {
  const clock = fakeClock();
  const random = fakeRandom();
  const s = settings();
  const sign = signer(clock);
  const store = memoryStore(clock);
  const metadata = scriptedMetadata({ [CIMD_ID]: { client_id: CIMD_ID, client_name: 'Agent', redirect_uris: ['http://127.0.0.1/cb'] } });
  const clients = new ClientRegistry(store, metadata, hasher, random, clock);
  const sessions = new SessionService(s, sign, random);
  const codes = new AuthorizationCodes(store, hasher, random);
  const authorization = new AuthorizationService(s, clients, sessions, codes, sign, random, clock, store);
  const tokens = new TokenService(s, store, clients, codes, hasher, random, clock, silentLogger);
  const verifier = new AccessTokenVerifier(s, store, hasher);
  return { clock, random, s, sign, store, metadata, clients, sessions, codes, authorization, tokens, verifier };
}

const VERIFIER = 'a'.repeat(50);
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');

function query(overrides = {}) {
  return {
    clientId: CIMD_ID, redirectUri: 'http://127.0.0.1:5555/cb', responseType: 'code', codeChallenge: CHALLENGE,
    codeChallengeMethod: 'S256', scope: undefined, resource: undefined, state: 'st', ...overrides
  };
}

async function approvedCode(w, session) {
  const begin = await w.authorization.begin(query(), session);
  assert.equal(begin.kind, 'consent');
  const decided = await w.authorization.decide(begin.view.ticket, 'approve', session);
  assert.equal(decided.kind, 'redirect');
  return decided.params.code;
}

const creds = { clientId: CIMD_ID, clientSecret: undefined, usedBasic: false };
const exchange = (w, code, extra = {}) => w.tokens.exchange(creds, {
  grantType: 'authorization_code', code, redirectUri: 'http://127.0.0.1:5555/cb', codeVerifier: VERIFIER,
  refreshToken: undefined, scope: undefined, resource: undefined, ...extra
});

test('authorize: login first, then a single-use consent ticket; iss and state on every redirect', async () => {
  const w = world();
  assert.equal((await w.authorization.begin(query(), undefined)).kind, 'login');
  const session = w.sessions.issue('FullFran').value;
  const begin = await w.authorization.begin(query(), session);
  assert.equal(begin.kind, 'consent');
  assert.equal(begin.view.clientName, 'Agent');
  const denied = await w.authorization.decide(begin.view.ticket, 'deny', session);
  assert.deepEqual([denied.params.error, denied.params.iss, denied.params.state], ['access_denied', 'https://board.example', 'st']);
  const again = await w.authorization.decide(begin.view.ticket, 'approve', session);
  assert.equal(again.kind, 'error_page');
  const other = w.sessions.issue('FullFran').value;
  const begin2 = await w.authorization.begin(query(), session);
  assert.equal((await w.authorization.decide(begin2.view.ticket, 'approve', other)).kind, 'error_page', 'ticket bound to its session');
});

test('authorize: errors redirect with iss; unregistered redirects never redirect', async () => {
  const w = world();
  const session = w.sessions.issue('FullFran').value;
  assert.equal((await w.authorization.begin(query({ redirectUri: 'https://evil.example/cb' }), session)).kind, 'error_page');
  for (const [overrides, error] of [
    [{ codeChallengeMethod: 'plain' }, 'invalid_request'],
    [{ codeChallenge: undefined }, 'invalid_request'],
    [{ scope: 'admin' }, 'invalid_scope'],
    [{ resource: 'https://other.example/mcp' }, 'invalid_target'],
    [{ responseType: 'token' }, 'unsupported_response_type']
  ]) {
    const result = await w.authorization.begin(query(overrides), session);
    assert.equal(result.kind, 'redirect');
    assert.equal(result.params.error, error);
    assert.equal(result.params.iss, 'https://board.example');
  }
});

test('tokens: PKCE checked, code single use, replay revokes, refresh rotates with family revocation', async () => {
  const w = world();
  const session = w.sessions.issue('FullFran').value;
  const badCode = await approvedCode(w, session);
  assert.equal((await exchange(w, badCode, { codeVerifier: 'b'.repeat(50) })).error, 'invalid_grant');
  assert.equal((await exchange(w, badCode)).error, 'invalid_grant', 'burnt after a failed attempt');

  const code = await approvedCode(w, session);
  const issued = await exchange(w, code);
  assert.equal(issued.ok, true);
  assert.equal(w.verifier.verify(issued.body.access_token, 'https://board.example/mcp').ok, true);
  assert.equal(w.verifier.verify(issued.body.access_token, 'https://other.example/mcp').ok, false, 'audience-bound');
  assert.equal((await exchange(w, code)).error, 'invalid_grant');
  assert.equal(w.verifier.verify(issued.body.access_token, 'https://board.example/mcp').ok, false, 'replay revoked the tokens');

  const fresh = await exchange(w, await approvedCode(w, session));
  const refresh = (token) => w.tokens.exchange(creds, { grantType: 'refresh_token', refreshToken: token, code: undefined, redirectUri: undefined, codeVerifier: undefined, scope: undefined, resource: undefined });
  const rotated = await refresh(fresh.body.refresh_token);
  assert.equal(rotated.ok, true);
  assert.notEqual(rotated.body.refresh_token, fresh.body.refresh_token);
  assert.equal((await refresh(fresh.body.refresh_token)).error, 'invalid_grant');
  assert.equal((await refresh(rotated.body.refresh_token)).error, 'invalid_grant', 'family revoked');
  assert.equal(w.verifier.verify(rotated.body.access_token, 'https://board.example/mcp').ok, false);
});

test('tokens: expired code and access token', async () => {
  const w = world();
  const session = w.sessions.issue('FullFran').value;
  const code = await approvedCode(w, session);
  w.clock.advance(61_000);
  assert.equal((await exchange(w, code)).description, 'authorization code expired');
  const live = await exchange(w, await approvedCode(w, w.sessions.issue('FullFran').value));
  w.clock.advance(3601_000);
  assert.equal(w.verifier.verify(live.body.access_token, 'https://board.example/mcp').ok, false);
});

test('clients: CIMD documents are cached; DCR clients with secrets authenticate by hash', async () => {
  const w = world();
  await w.clients.resolve(CIMD_ID);
  await w.clients.resolve(CIMD_ID);
  assert.equal(w.metadata.calls.length, 1, 'cached');
  w.clock.advance(121_000);
  await w.clients.resolve(CIMD_ID);
  assert.equal(w.metadata.calls.length, 2, 'refetched after max-age');
  await assert.rejects(w.clients.resolve('https://app.example/missing.json'), /HTTP 404/);
  const reg = w.clients.register({ redirect_uris: ['https://a.example/cb'], token_endpoint_auth_method: 'client_secret_post' });
  const client = await w.clients.resolve(reg.client_id);
  assert.equal(w.clients.authenticate(client, reg.client_secret), true);
  assert.equal(w.clients.authenticate(client, 'wrong'), false);
  assert.equal(JSON.stringify(w.store.getClient(reg.client_id)).includes(reg.client_secret), false, 'secret stored hashed');
});

test('sessions: allowlist re-checked on every read', () => {
  const w = world();
  const value = w.sessions.issue('FullFran').value;
  assert.equal(w.sessions.read(value).login, 'FullFran');
  const outsider = w.sessions.issue('mallory').value;
  assert.equal(w.sessions.read(outsider), null);
  assert.equal(w.sessions.read(`${value}x`), null);
});

test('device sign-in: waits the interval, honours slow_down, refuses accounts outside the allowlist', async () => {
  const clock = fakeClock();
  const github = scriptedGitHub();
  const sign = signer(clock);
  const device = new DeviceSignIn(settings(), github, sign, fakeRandom(), clock, silentLogger, memoryStore(clock));
  const started = await device.start('/\t/evil.example');
  assert.equal(started.kind, 'started');
  assert.equal((await device.poll(started.binding)).kind, 'pending');
  assert.equal(github.state.polls, 0, 'no poll before the interval');
  clock.advance(5000);
  github.state.next = [{ kind: 'slow_down' }];
  const slowed = await device.poll(started.binding);
  assert.equal(slowed.intervalSeconds, 10);
  clock.advance(5000);
  await device.poll(started.binding);
  assert.equal(github.state.polls, 1, 'waits the longer interval');
  clock.advance(5000);
  github.state.next = [{ kind: 'login', login: 'fullfran' }];
  const done = await device.poll(started.binding);
  assert.deepEqual(done, { kind: 'complete', login: 'fullfran', returnTo: '/' });
  assert.equal((await device.poll(started.binding)).kind, 'none', 'completed logins are forgotten');
  assert.equal((await device.poll(`${started.binding}x`)).kind, 'none', 'tampered binding');

  const other = await device.start('/');
  clock.advance(5000);
  github.state.next = [{ kind: 'login', login: 'mallory' }];
  assert.deepEqual(await device.poll(other.binding), { kind: 'failed', reason: 'not_allowed' });
  assert.equal(device.view(other.binding).kind, 'failed');
  assert.equal(device.view(other.binding).kind, 'none', 'failure shown once');
});

test('device sign-in: at most 20 pending logins', async () => {
  const clock = fakeClock();
  const device = new DeviceSignIn(settings(), scriptedGitHub(), signer(clock), fakeRandom(), clock, silentLogger, memoryStore(clock));
  for (let i = 0; i < 20; i += 1) assert.equal((await device.start('/')).kind, 'started');
  assert.equal((await device.start('/')).kind, 'too_many');
  clock.advance(901_000);
  assert.equal((await device.start('/')).kind, 'started', 'expired logins free their slot');
});

function fakeAuthenticator(result) {
  return {
    origin: 'https://board.example',
    calls: [],
    authenticate(headers, options) {
      this.calls.push({ headers, options });
      return typeof result === 'function' ? result(headers) : result;
    }
  };
}

const session = { ok: true, principal: { login: 'FullFran', via: 'session', scopes: ['whiteboard'] } };
const bearer = { ok: true, principal: { login: 'FullFran', via: 'bearer', scopes: ['whiteboard'] } };
const denied = { ok: false, status: 401, error: 'unauthorized', challenge: 'Bearer x' };

test('access gate: cookie writes need our Origin on every path and case; bearer writes do not', () => {
  const gate = new AccessGate(fakeAuthenticator(session), 'https://board.example/mcp');
  for (const path of ['/api/elements', '/API/elements', '/Api/elements/clear', '/anything']) {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      for (const origin of ['https://evil.example', undefined, 'null']) {
        const verdict = gate.decide({ method, path, headers: { cookie: 'c', origin } });
        assert.equal(verdict.status, 403, `${method} ${path} ${origin}`);
      }
      assert.equal(gate.decide({ method, path, headers: { cookie: 'c', origin: 'https://board.example' } }).kind, 'allow');
    }
  }
  assert.equal(gate.decide({ method: 'GET', path: '/API/elements', headers: { cookie: 'c' } }).kind, 'allow');
  const bearerGate = new AccessGate(fakeAuthenticator(bearer), 'https://board.example/mcp');
  assert.equal(bearerGate.decide({ method: 'POST', path: '/api/elements', headers: { authorization: 'Bearer t' } }).kind, 'allow');
});

test('access gate: UI needs the session (bearer ignored there); anonymous GET goes to sign-in', () => {
  const auth = fakeAuthenticator(headers => (headers.cookie ? session : denied));
  const gate = new AccessGate(auth, 'https://board.example/mcp');
  assert.equal(gate.decide({ method: 'GET', path: '/', headers: { authorization: 'Bearer t' } }).kind, 'login');
  assert.equal(auth.calls.at(-1).headers.authorization, undefined, 'the UI branch does not pass the bearer');
  assert.equal(gate.decide({ method: 'POST', path: '/', headers: {} }).status, 401);
  const api = gate.decide({ method: 'GET', path: '/api/elements', headers: {} });
  assert.deepEqual([api.status, api.challenge], [401, 'Bearer x']);
  assert.equal(auth.calls.at(-1).options.resource, 'https://board.example/mcp');
});

test('access gate: WebSocket needs a bearer, or the session with our Origin', () => {
  const auth = fakeAuthenticator(headers => (headers.authorization ? bearer : headers.cookie ? session : denied));
  const gate = new AccessGate(auth, 'https://board.example/mcp');
  assert.deepEqual(gate.decideUpgrade({ authorization: 'Bearer t' }), { ok: true });
  assert.deepEqual(gate.decideUpgrade({ cookie: 'c', origin: 'https://board.example' }), { ok: true });
  assert.equal(gate.decideUpgrade({ cookie: 'c' }).status, 403);
  assert.equal(gate.decideUpgrade({ cookie: 'c', origin: 'https://evil.example' }).status, 403);
  assert.equal(gate.decideUpgrade({}).status, 401);
});

test('device sign-in: a login started on one gateway completes on the other, and polls GitHub once per interval', async () => {
  const clock = fakeClock();
  const github = scriptedGitHub();
  github.state.next = [{ kind: 'login', login: 'FullFran' }];
  const store = memoryStore(clock);
  const sign = signer(clock);
  const a = new DeviceSignIn(settings(), github, sign, fakeRandom(), clock, silentLogger, store);
  const b = new DeviceSignIn(settings(), github, sign, fakeRandom(), clock, silentLogger, store);
  const started = await a.start('/board');
  assert.equal(b.view(started.binding).kind, 'waiting', 'the other gateway shows the code');
  clock.advance(5000);
  const [first, second] = await Promise.all([b.poll(started.binding), a.poll(started.binding)]);
  assert.equal(github.state.polls, 1, 'two gateways polling at once call GitHub once');
  assert.equal([first, second].filter(r => r.kind === 'complete').length, 1, 'exactly one gateway completes the login');
  assert.equal([first, second].find(r => r.kind === 'complete').login, 'FullFran');
  assert.equal((await a.poll(started.binding)).kind, 'none', 'the login is gone after completing');
});

test('device sign-in: the binding cookie is sealed and the device code is never stored', async () => {
  const clock = fakeClock();
  const store = memoryStore(clock);
  const puts = [];
  const spy = { ...store, putDeviceLogin: (nonce, record) => { puts.push(record); store.putDeviceLogin(nonce, record); } };
  const device = new DeviceSignIn(settings(), scriptedGitHub(), signer(clock), fakeRandom(), clock, silentLogger, spy);
  const started = await device.start('/');
  assert.ok(!started.binding.includes('dev1') && !Buffer.from(started.binding.split('.')[1], 'base64url').toString().includes('dev1'),
    'the device code cannot be read from the cookie');
  assert.ok(puts.length > 0 && puts.every(record => !JSON.stringify(record).includes('dev1')), 'no stored record holds the device code');
});

test('sealed tickets: readable only with the key, bound to their purpose, tamper-proof and expiring', () => {
  const clock = fakeClock();
  const sign = signer(clock);
  const sealed = sign.seal('device-login', { n: 'nonce', d: 'secret-device-code' }, 60);
  assert.ok(!sealed.includes('secret') && !sealed.split('.').some(part => Buffer.from(part, 'base64url').toString().includes('secret')));
  assert.equal(sign.open('device-login', sealed)?.d, 'secret-device-code');
  assert.equal(sign.open('other-purpose', sealed), null);
  assert.equal(sign.verify('device-login', sealed), null, 'a sealed value is not a signed one');
  const [iv, data, tag] = sealed.split('.');
  const flipped = Buffer.from(data, 'base64url'); flipped[0] ^= 1;
  assert.equal(sign.open('device-login', [iv, flipped.toString('base64url'), tag].join('.')), null);
  assert.equal(new HmacTicketSigner(Buffer.from('y'.repeat(40)), clock).open('device-login', sealed), null, 'another secret cannot open it');
  clock.advance(61_000);
  assert.equal(sign.open('device-login', sealed), null);
});
