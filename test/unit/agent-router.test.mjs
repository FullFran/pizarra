// The agent's HTTP surface through the real gateway app: flag off, who may use it, the Origin and
// content-type rules, the prompt stream, the events stream, and engine tokens on /mcp.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { AgentAllowlist } from '../../dist/agent/allowlist.js';
import { AgentHub } from '../../dist/agent/hub.js';
import { AgentManager } from '../../dist/agent/manager.js';
import { AGENT_TOOLS } from '../../dist/agent/protocol.js';
import { createAgentRouter } from '../../dist/agent/router.js';
import { EngineTokens, engineConnectionCheck, withConnection } from '../../dist/agent/tokens.js';
import { CredentialVault } from '../../dist/agent/vault.js';
import { HttpRequestAuthenticator } from '../../dist/auth/index.js';
import { EngineProvider } from '../../dist/auth/plugins/engine.js';
import { createGatewayApp } from '../../dist/gateway/presentation/http/app.js';
import { silentLogger } from './fakes.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_ENGINE = join(here, '../fixtures/agent/fake-engine.mjs');
const credential = { access: 'a', refresh: 'r', expires: Date.now() + 3_600_000, accountId: 'acct' };
const scratch = [];
process.on('exit', () => { for (const dir of scratch) rmSync(dir, { recursive: true, force: true }); });

/**
 * Cookie `s=<login>` is a GitHub session; `s=<login>:ticket` an issuer's. Roles per login on the
 * boards `b1` and `main`; `ghost` has none.
 */
const ROLES = { fullfran: 'editor', ownerperson: 'owner', viewerperson: 'viewer', stranger: 'editor', ticketperson: 'editor' };
const AGENT_USERS = 'FullFran,ownerperson,viewerperson,ticketperson';

function fakeBoards() {
  const known = new Set(['main', 'b1', 'b2']);
  return {
    exists: id => known.has(id),
    summary: (id, principal) => {
      if (!known.has(id) || (principal?.board !== undefined && principal.board !== id)) return undefined;
      const role = ROLES[principal?.login];
      return role ? { id, name: id, role, kind: 'github' } : undefined;
    },
    list: () => [], create: () => ({ ok: false }), members: () => ({ ok: false }), setMember: () => ({ ok: false }), removeMember: () => ({ ok: false })
  };
}

function sessionAuthenticator() {
  return {
    origin: '',
    authenticate(headers) {
      const match = /(?:^|;\s*)s=([^;]+)/.exec(headers.cookie ?? '');
      if (!match) return { ok: false, status: 401, error: 'unauthorized', challenge: 'Bearer' };
      const [login, kind] = match[1].split(':');
      const principal = kind === 'ticket'
        ? { login, provider: 'trusted-issuer', issuer: 'https://issuer', role: 'editor', board: 'b1', via: 'session', scopes: [] }
        : { login, provider: 'github', via: 'session', scopes: [] };
      return { ok: true, principal };
    }
  };
}

async function start({ agent = true, authenticator = sessionAuthenticator(), keepaliveMs, engineHostCheck = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-router-'));
  scratch.push(dir);
  const vault = new CredentialVault(dir, Buffer.alloc(32, 3));
  const tokens = new EngineTokens();
  const hub = new AgentHub();
  const manager = new AgentManager({ vault, tokens, hub, mcpUrl: b => `http://127.0.0.1:1/b/${b}/mcp`, maxProcesses: 2, entry: FAKE_ENGINE, abortGraceMs: 500 });
  const factoryCalls = [];
  const holder = {};
  const app = createGatewayApp({
    bindHost: '127.0.0.1', trustProxy: false, logger: silentLogger,
    auth: { router: (_req, _res, next) => next(), authenticator, resource: 'x' },
    mcpFactoryFor: async board => { factoryCalls.push(board); throw new Error('reached the MCP handler'); },
    boards: fakeBoards(),
    upstream: { host: '127.0.0.1', port: 1, baseUrl: 'http://127.0.0.1:1', isReady: () => true },
    proxy: { web: (_req, res) => { res.status(599).json({ proxied: true }); }, upgrade() {} },
    ...(agent ? {
      agent: {
        tools: AGENT_TOOLS,
        withConnection,
        router: createAgentRouter({ manager, hub, allowlist: AgentAllowlist.parse(AGENT_USERS), get origin() { return holder.origin; }, ...(keepaliveMs ? { keepaliveMs } : {}) })
      }
    } : {})
  }).app;
  const server = createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  holder.origin = `http://127.0.0.1:${port}`;
  authenticator.origin = holder.origin;
  authenticator.setOrigin?.(holder.origin);
  const ctx = { dir, vault, tokens, hub, manager, port, origin: holder.origin, factoryCalls, server, engineHost: `127.0.0.1:${port}` };
  ctx.close = async () => { await manager.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); };
  return ctx;
}

function call(ctx, method, path, { headers = {}, body, json = true, origin = ctx.origin, session = 'fullfran' } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const req = request({
      host: '127.0.0.1', port: ctx.port, method, path,
      headers: {
        ...(session ? { cookie: `s=${session}` } : {}),
        ...(method === 'POST' && origin ? { origin } : {}),
        ...(method === 'POST' && json ? { 'content-type': 'application/json' } : {}),
        ...headers
      }
    }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

/** Opens an SSE stream and returns what arrived so far on demand. */
function stream(ctx, path, session = 'stranger') {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: ctx.port, method: 'GET', path, headers: { cookie: `s=${session}` } }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      resolve({
        status: res.statusCode, headers: res.headers, text: () => text, close: () => req.destroy(),
        until: async (predicate, ms = 3000) => {
          const end = Date.now() + ms;
          while (!predicate(text)) {
            if (Date.now() > end) throw new Error(`timed out; got ${JSON.stringify(text)}`);
            await new Promise(r => setTimeout(r, 10));
          }
          return text;
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function parseSse(text) {
  return text.split('\n\n').filter(block => block.startsWith('event:')).map(block => {
    const [event, data] = block.split('\n');
    return [event.slice(7), JSON.parse(data.slice(6))];
  });
}

test('with the agent off every /__agent/ route is a 404, for any board and any person', async t => {
  const ctx = await start({ agent: false });
  t.after(ctx.close);
  for (const [method, path] of [['GET', '/b/b1/__agent/status'], ['GET', '/b/b1/__agent/events'], ['POST', '/b/b1/__agent/prompt'], ['POST', '/b/b1/__agent/login'], ['GET', '/__agent/status'], ['GET', '/b/b1/__agent']]) {
    const res = await call(ctx, method, path, { body: method === 'POST' ? { text: 'x' } : undefined });
    assert.equal(res.status, 404, `${method} ${path}`);
    assert.notEqual(res.status, 599, 'not proxied upstream');
  }
  assert.equal((await call(ctx, 'GET', '/b/b1/__agent/status', { session: null })).status, 404, 'not even a sign-in redirect');
});

test('status: allowlisted editors get the real answer, everyone else enabled:false; no session is 401', async t => {
  const ctx = await start();
  t.after(ctx.close);
  const status = async (path, session) => (await call(ctx, 'GET', path, { session })).json();
  assert.deepEqual(await status('/b/b1/__agent/status', 'fullfran'), { enabled: true, connected: false, busy: false, pending: null });
  assert.deepEqual(await status('/__agent/status', 'ownerperson'), { enabled: true, connected: false, busy: false, pending: null }, 'main board too');
  const off = { enabled: false, connected: false, busy: false, pending: null };
  assert.deepEqual(await status('/b/b1/__agent/status', 'stranger'), off, 'not allowlisted');
  assert.deepEqual(await status('/b/b1/__agent/status', 'viewerperson'), off, 'allowlisted but a viewer');
  assert.deepEqual(await status('/b/b1/__agent/status', 'ticketperson:ticket'), off, "an issuer's ticket is never the agent's person");
  ctx.vault.write('fullfran', credential);
  assert.deepEqual(await status('/b/b1/__agent/status', 'fullfran'), { enabled: true, connected: true, busy: false, pending: null });
  assert.equal((await call(ctx, 'GET', '/b/b1/__agent/status', { session: null })).status, 401);
  assert.equal((await call(ctx, 'GET', '/b/b1/__agent/status', { session: 'ghost' })).status, 404, 'a board you cannot open does not exist');
  assert.equal((await call(ctx, 'GET', '/b/nope/__agent/status')).status, 404);
});

test('not allowed: 404 for everything but status and events, whatever the method', async t => {
  const ctx = await start();
  t.after(ctx.close);
  for (const session of ['stranger', 'viewerperson', 'ticketperson:ticket']) {
    for (const action of ['login', 'logout', 'abort', 'reset', 'prompt']) {
      const res = await call(ctx, 'POST', `/b/b1/__agent/${action}`, { session, body: { text: 'hello' } });
      assert.equal(res.status, 404, `${session} ${action}`);
    }
    assert.equal((await call(ctx, 'GET', '/b/b1/__agent/prompt', { session })).status, 404);
  }
  const events = await stream(ctx, '/b/b1/__agent/events', 'viewerperson');
  assert.equal(events.status, 200, 'a viewer may watch');
  events.close();
});

test('POST rules: Origin must be our own, the body JSON, the text 1..8000 characters', async t => {
  const ctx = await start();
  t.after(ctx.close);
  const url = '/b/b1/__agent/login';
  assert.equal((await call(ctx, 'POST', url, { origin: null, body: {} })).status, 403, 'no Origin');
  assert.equal((await call(ctx, 'POST', url, { origin: 'https://evil.example', body: {} })).status, 403);
  assert.equal((await call(ctx, 'POST', url, { headers: { referer: `${ctx.origin}/` }, origin: null, body: {} })).status, 403, 'a Referer is not enough');
  assert.equal((await call(ctx, 'POST', url, { json: false, headers: { 'content-type': 'text/plain' }, body: '{}' })).status, 415);
  assert.equal((await call(ctx, 'POST', url, { json: false, body: '{}' })).status, 415, 'no content type');
  const bad = await call(ctx, 'POST', '/b/b1/__agent/prompt', { body: '{nope' });
  assert.equal(bad.status, 400);
  ctx.vault.write('fullfran', credential);
  for (const body of [{}, { text: '' }, { text: '   ' }, { text: 5 }, { text: 'x'.repeat(8001) }, []]) {
    const res = await call(ctx, 'POST', '/b/b1/__agent/prompt', { body });
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 30));
    assert.deepEqual(res.json(), { error: 'invalid_text' });
  }
  assert.equal((await call(ctx, 'POST', '/b/b1/__agent/abort', { body: {} })).status, 204);
  assert.equal((await call(ctx, 'POST', '/b/b1/__agent/reset', { body: {} })).status, 204);
  const prompt = await call(ctx, 'POST', '/b/b1/__agent/prompt', { body: { text: 'x'.repeat(8000) } });
  assert.equal(prompt.status, 200, 'exactly 8000 is fine');
});

test('prompt refusals before streaming are JSON codes; login and logout round trip', async t => {
  const ctx = await start();
  t.after(ctx.close);
  const refused = await call(ctx, 'POST', '/b/b1/__agent/prompt', { body: { text: 'draw' } });
  assert.equal(refused.status, 409);
  assert.deepEqual(refused.json(), { error: 'not_connected' });
  const login = await call(ctx, 'POST', '/b/b1/__agent/login', { body: {} });
  assert.equal(login.status, 200);
  assert.deepEqual(login.json(), { userCode: 'FAKE-1234', verificationUri: 'https://auth.openai.com/codex/device' });
  assert.deepEqual((await call(ctx, 'GET', '/b/b1/__agent/status')).json().pending, login.json());
  for (let i = 0; i < 50 && !ctx.vault.read('fullfran'); i += 1) await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual((await call(ctx, 'GET', '/b/b1/__agent/status')).json(), { enabled: true, connected: true, busy: false, pending: null });
  assert.equal((await call(ctx, 'POST', '/b/b1/__agent/logout', { body: {} })).status, 204);
  assert.equal(ctx.vault.read('fullfran'), null);
  assert.equal((await call(ctx, 'GET', '/b/b1/__agent/status')).json().connected, false);
});

test('prompt streams delta, thinking, tool and done in order, and other people see the drafts', async t => {
  const ctx = await start();
  t.after(ctx.close);
  ctx.vault.write('fullfran', credential);
  const watcher = await stream(ctx, '/b/b1/__agent/events', 'stranger');
  assert.equal(watcher.status, 200);
  assert.match(watcher.headers['content-type'], /^text\/event-stream/);
  const elsewhere = await stream(ctx, '/b/b2/__agent/events', 'stranger');

  const res = await call(ctx, 'POST', '/b/b1/__agent/prompt', { body: { text: 'draw' } });
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /^text\/event-stream/);
  assert.equal(res.headers['cache-control'], 'no-store');
  const events = parseSse(res.text);
  assert.deepEqual(events.map(([name]) => name), ['thinking', 'delta', 'tool', 'tool', 'delta', 'done']);
  assert.deepEqual(events[0][1], { text: 'planning' });
  assert.deepEqual(events[2][1], { call: 1, name: 'batch_create_elements', phase: 'start', ok: true });
  assert.deepEqual(events[5][1], { aborted: false });

  const text = await watcher.until(t => t.includes('event: draft.end') && t.includes('"state":"idle"'));
  const seen = parseSse(text);
  assert.deepEqual(seen.map(([name]) => name), ['agent', 'draft', 'draft', 'draft.end', 'agent']);
  assert.deepEqual(seen[0][1], { state: 'working', login: 'fullfran' });
  assert.match(seen[1][1].id, /^[a-z0-9-]{1,40}$/);
  assert.deepEqual(seen[2][1].elements.map(e => e.type), ['rectangle', 'ellipse']);
  assert.equal(seen[3][1].id, seen[1][1].id);
  assert.ok(!elsewhere.text().includes('draft'), 'another board hears nothing');
  watcher.close();
  elsewhere.close();
});

test('closing the prompt stream aborts the turn', async t => {
  const ctx = await start();
  t.after(ctx.close);
  ctx.vault.write('fullfran', credential);
  const prompt = await new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: ctx.port, method: 'POST', path: '/b/b1/__agent/prompt', headers: { cookie: 's=fullfran', origin: ctx.origin, 'content-type': 'application/json' } }, res => { res.resume(); resolve({ req, res }); });
    req.on('error', () => {});
    req.end(JSON.stringify({ text: 'hang' }));
    void reject;
  });
  for (let i = 0; i < 100 && !ctx.manager.status('fullfran', 'b1').busy; i += 1) await new Promise(r => setTimeout(r, 10));
  assert.equal(ctx.manager.status('fullfran', 'b1').busy, true);
  prompt.req.destroy();
  for (let i = 0; i < 100 && ctx.manager.status('fullfran', 'b1').busy; i += 1) await new Promise(r => setTimeout(r, 20));
  assert.equal(ctx.manager.status('fullfran', 'b1').busy, false);
});

test('events: keepalive comments, and a new listener learns who is working', async t => {
  const ctx = await start({ keepaliveMs: 30 });
  t.after(ctx.close);
  ctx.hub.agent('b1', 'working', 'fullfran');
  const watcher = await stream(ctx, '/b/b1/__agent/events');
  const text = await watcher.until(t => t.includes(': keepalive') && t.includes('working'));
  assert.match(text, /event: agent\ndata: \{"state":"working","login":"fullfran"\}/);
  watcher.close();
  for (let i = 0; i < 50 && ctx.hub.listenerCount('b1') > 0; i += 1) await new Promise(r => setTimeout(r, 10));
  assert.equal(ctx.hub.listenerCount('b1'), 0, 'the listener leaves with its connection');
});

test('engine tokens on /mcp: this board only, loopback only, agent tools only, editors only', async t => {
  const tokens = new EngineTokens();
  const holder = {};
  const provider = new EngineProvider({ resolve: token => tokens.resolve(token), isEngineConnection: () => holder.check() });
  const authenticator = new HttpRequestAuthenticator([provider], 'http://placeholder', () => 'Bearer realm="pizarra"');
  const ctx = await start({ authenticator });
  t.after(ctx.close);
  // Rebuild the check and the authenticator now that the port is known.
  holder.check = engineConnectionCheck(ctx.engineHost);
  Object.defineProperty(authenticator, 'origin', { value: ctx.origin });
  const mint = (login, board) => tokens.mint({ login, board }, 60_000);
  const rpc = (name, extra = {}) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} }, ...extra });
  const mcp = (path, token, body, headers = {}) => call(ctx, 'POST', path, {
    session: null, origin: null, body,
    headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream', ...headers }
  });
  const token = mint('fullfran', 'b1');

  const allowed = await mcp('/b/b1/mcp', token, rpc('describe_scene'));
  assert.deepEqual(ctx.factoryCalls, ['b1'], `allowed tool reaches the MCP handler (status ${allowed.status})`);
  ctx.factoryCalls.length = 0;
  const refused = await mcp('/b/b1/mcp', token, rpc('clear_canvas'));
  assert.equal(refused.status, 403);
  assert.match(refused.text, /may not call clear_canvas/);
  assert.equal((await mcp('/b/b1/mcp', token, [rpc('describe_scene'), rpc('import_scene')])).status, 403, 'a batch');
  assert.equal((await mcp('/b/b1/mcp', token, rpc('describe_scene'), { 'mcp-method': 'tools/call', 'mcp-name': 'clear_canvas' })).status, 403);
  assert.deepEqual(ctx.factoryCalls, [], 'refused calls never reach the handler');

  assert.equal((await mcp('/b/b2/mcp', token, rpc('describe_scene'))).status, 401, 'another board');
  assert.equal((await mcp('/mcp', token, rpc('describe_scene'))).status, 401, 'board main is another board');
  assert.equal((await mcp('/b/b1/mcp', token, rpc('describe_scene'), { 'x-forwarded-for': '203.0.113.9' })).status, 401, 'behind a proxy');
  assert.equal((await mcp('/b/b1/mcp', token, rpc('describe_scene'), { host: `localhost:${ctx.port}` })).status, 401, 'not the host the engine dials');
  assert.equal((await mcp('/b/b1/mcp', `${token}x`, rpc('describe_scene'))).status, 401, 'unknown token');
  assert.equal((await mcp('/b/b1/mcp', mint('viewerperson', 'b1'), rpc('describe_scene'))).status, 403, 'a viewer');
  assert.equal((await mcp('/b/b1/mcp', mint('ghost', 'b1'), rpc('describe_scene'))).status, 404, 'a person with no role on the board');
  assert.deepEqual(ctx.factoryCalls, []);

  // Never anywhere else: the board's REST API, its pages, the agent routes, the boards API.
  for (const [method, path] of [['GET', '/b/b1/api/elements'], ['POST', '/b/b1/api/elements'], ['GET', '/api/elements'], ['GET', '/b/b1/__agent/status'], ['POST', '/b/b1/__agent/prompt'], ['GET', '/b/b1/__agent/events'], ['GET', '/boards']]) {
    const res = await call(ctx, method, path, { session: null, origin: ctx.origin, body: method === 'POST' ? { text: 'draw' } : undefined, headers: { authorization: `Bearer ${token}` } });
    assert.ok(res.status === 401, `${method} ${path} answered ${res.status}`);
  }
  assert.equal(ctx.tokens.size, 0, 'the test server minted none');
});

test('the gateway refuses to build with the agent but without authentication', () => {
  assert.throws(() => createGatewayApp({
    bindHost: '127.0.0.1', trustProxy: false, logger: silentLogger, mcpFactoryFor: async () => undefined, boards: fakeBoards(),
    upstream: { host: '127.0.0.1', port: 1, baseUrl: 'http://127.0.0.1:1', isReady: () => true }, proxy: {},
    agent: { tools: AGENT_TOOLS, withConnection, router: () => {} }
  }), /authentication/);
});

test('the agent script is served only with the agent on', async t => {
  const on = await start();
  t.after(on.close);
  const served = await fetch(`${on.origin}/__pizarra/agent.js`);
  assert.equal(served.status, 200);
  assert.match(served.headers.get('content-type') ?? '', /javascript/);
  assert.match(await served.text(), /'\/__agent'/);
  const off = await start({ agent: false });
  t.after(off.close);
  const missing = await fetch(`${off.origin}/__pizarra/agent.js`);
  assert.notEqual(missing.status, 200);
});

test('the main board page at / redirects to /b/main/ so it gets the board and agent scripts', async t => {
  const ctx = await start();
  t.after(ctx.close);
  for (const [path, location] of [['/', '/b/main/'], ['/?embed=1', '/b/main/?embed=1']]) {
    const res = await fetch(`${ctx.origin}${path}`, { redirect: 'manual', headers: { cookie: 's=fullfran' } });
    assert.equal(res.status, 302, path);
    assert.equal(res.headers.get('location'), location, path);
  }
  const api = await call(ctx, 'GET', '/api/elements');
  assert.notEqual(api.status, 302, 'unprefixed API paths still go to the main board');
});
