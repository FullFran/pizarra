// The agent's host side: config, allowlist, credential vault, engine tokens and their identity
// plugin, the tool policy on /mcp, and the process manager driven by a fake engine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentAllowlist } from '../../dist/agent/allowlist.js';
import { parseAgentKey, resolveAgentConfig } from '../../dist/agent/config.js';
import { AgentHub } from '../../dist/agent/hub.js';
import { AgentManager, EngineError } from '../../dist/agent/manager.js';
import { AGENT_SYSTEM_PROMPT } from '../../dist/agent/prompt.js';
import { AGENT_TOOLS } from '../../dist/agent/protocol.js';
import { EngineTokens, engineConnectionCheck, isDirectLoopback } from '../../dist/agent/tokens.js';
import { CredentialVault, VaultError } from '../../dist/agent/vault.js';
import { EngineProvider } from '../../dist/auth/plugins/engine.js';
import { agentRequestVerdict } from '../../dist/gateway/domain/agent-policy.js';

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_ENGINE = join(here, '../fixtures/agent/fake-engine.mjs');
const KEY = Buffer.alloc(32, 7);
const scratch = [];
const tempDir = () => { const dir = mkdtempSync(join(tmpdir(), 'agent-host-')); scratch.push(dir); return dir; };
process.on('exit', () => { for (const dir of scratch) rmSync(dir, { recursive: true, force: true }); });
const credential = { access: 'a-secret', refresh: 'r-secret', expires: Date.now() + 3_600_000, accountId: 'acct' };

test('config: off by default, and on only with every variable valid (errors name the variable)', () => {
  assert.equal(resolveAgentConfig({}, {}), undefined);
  assert.equal(resolveAgentConfig({ PIZARRA_AGENT: '0', PIZARRA_AGENT_KEY: 'garbage' }, {}), undefined, 'nothing is read when off');
  const base = { PIZARRA_AGENT: '1', PIZARRA_AGENT_USERS: 'FullFran, Other-One', PIZARRA_AGENT_KEY: KEY.toString('base64') };
  const config = resolveAgentConfig(base, { dataDir: '/data' });
  assert.equal(config.maxProcesses, 2);
  assert.equal(config.models, undefined);
  assert.ok(config.users.has('fullfran') && config.users.has('OTHER-ONE'));
  assert.deepEqual(resolveAgentConfig({ ...base, PIZARRA_AGENT_MODELS: 'gpt-5.1, gpt-5-mini', PIZARRA_AGENT_MAX_PROCESSES: '4' }, { dataDir: '/data' }).models, ['gpt-5.1', 'gpt-5-mini']);
  assert.throws(() => resolveAgentConfig({ ...base, PIZARRA_AGENT: 'yes' }, { dataDir: '/data' }), /PIZARRA_AGENT /);
  assert.throws(() => resolveAgentConfig(base, {}), /EXCALIDRAW_DATA_DIR/);
  assert.throws(() => resolveAgentConfig({ ...base, PIZARRA_AGENT_USERS: undefined }, { dataDir: '/d' }), /PIZARRA_AGENT_USERS/);
  assert.throws(() => resolveAgentConfig({ ...base, PIZARRA_AGENT_KEY: undefined }, { dataDir: '/d' }), /PIZARRA_AGENT_KEY/);
  assert.throws(() => resolveAgentConfig({ ...base, PIZARRA_AGENT_KEY: 'c2hvcnQ=' }, { dataDir: '/d' }), /PIZARRA_AGENT_KEY/);
  assert.throws(() => resolveAgentConfig({ ...base, PIZARRA_AGENT_MAX_PROCESSES: '0' }, { dataDir: '/d' }), /PIZARRA_AGENT_MAX_PROCESSES/);
  assert.throws(() => resolveAgentConfig({ ...base, PIZARRA_AGENT_MODELS: 'ok,bad model!' }, { dataDir: '/d' }), /PIZARRA_AGENT_MODELS/);
  assert.equal(parseAgentKey(KEY.toString('base64url')).length, 32);
});

test('allowlist: comma separated, case-insensitive, never empty, only GitHub logins', () => {
  const list = AgentAllowlist.parse(' FullFran ,a-b,, x1 ');
  assert.equal(list.size, 3);
  assert.ok(list.has('fullfran') && list.has('FULLFRAN') && list.has('A-B'));
  assert.ok(!list.has('someone') && !list.has(''));
  for (const bad of [undefined, '', ' , ', 'has space', '-lead', 'a'.repeat(40), 'a/b', 'a;b']) assert.throws(() => AgentAllowlist.parse(bad), /PIZARRA_AGENT_USERS/, String(bad));
});

test('vault: encrypted round trip per person, 0600, tamper and moved files do not decrypt', () => {
  const dir = tempDir();
  const vault = new CredentialVault(dir, KEY);
  assert.equal(vault.read('FullFran'), null);
  vault.write('FullFran', credential);
  assert.deepEqual(vault.read('fullfran'), credential, 'logins are case-insensitive');
  const path = vault.pathFor('FullFran');
  assert.match(path, /agent\/credentials\/[0-9a-f]{64}\.json$/);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const raw = readFileSync(path, 'utf8');
  assert.ok(!raw.includes('a-secret') && !raw.includes('r-secret'));
  assert.deepEqual(readdirSync(join(dir, 'agent', 'credentials')).filter(name => name.endsWith('.tmp')), []);

  assert.throws(() => new CredentialVault(dir, Buffer.alloc(32, 8)).read('fullfran'), VaultError, 'another key');
  const file = JSON.parse(raw);
  const flipped = Buffer.from(file.data, 'base64');
  flipped[0] ^= 1;
  writeFileSync(path, JSON.stringify({ ...file, data: flipped.toString('base64') }));
  assert.throws(() => vault.read('fullfran'), VaultError, 'a flipped byte');

  vault.write('fullfran', credential);
  vault.write('other', { ...credential, access: 'other-access' });
  writeFileSync(vault.pathFor('other'), readFileSync(vault.pathFor('fullfran')));
  assert.throws(() => vault.read('other'), VaultError, "one person's file under another's name");
  vault.delete('fullfran');
  assert.equal(vault.read('fullfran'), null);
});

test('engine tokens: prefixed, hashed, bound to login and board, expiring, revocable', () => {
  let now = 1_000_000;
  const tokens = new EngineTokens(() => now);
  const token = tokens.mint({ login: 'FullFran', board: 'b1' }, 60_000);
  assert.match(token, /^pze_[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(tokens.resolve(token), { login: 'fullfran', board: 'b1', expiresAt: 1060 });
  assert.equal(tokens.resolve(`${token}x`), null);
  assert.equal(tokens.resolve('pze_'), null);
  assert.equal(tokens.resolve(token.slice(4)), null);
  now += 60_000;
  assert.equal(tokens.resolve(token), null, 'expired');
  const second = tokens.mint({ login: 'a', board: 'b' }, 1000);
  tokens.revoke(second);
  assert.equal(tokens.resolve(second), null, 'revoked');
});

test('direct loopback: only a loopback peer with no proxy header counts', () => {
  assert.ok(isDirectLoopback('127.0.0.1', { host: '127.0.0.1:3000' }));
  assert.ok(isDirectLoopback('::1', {}));
  assert.ok(isDirectLoopback('::ffff:127.0.0.1', {}));
  assert.ok(!isDirectLoopback('10.0.0.5', {}));
  assert.ok(!isDirectLoopback(undefined, {}));
  for (const header of ['x-forwarded-for', 'X-Forwarded-Host', 'forwarded', 'via', 'x-real-ip', 'cf-connecting-ip', 'true-client-ip']) {
    assert.ok(!isDirectLoopback('127.0.0.1', { [header]: 'x' }), header);
  }
  assert.equal(engineConnectionCheck('127.0.0.1:3000')(), false, 'outside an /mcp authentication nothing is an engine connection');
});

test('engine identity plugin: a token opens its own board only, and only where the connection is the engine\'s', () => {
  const tokens = new EngineTokens();
  const token = tokens.mint({ login: 'fullfran', board: 'b1' }, 60_000);
  let direct = true;
  const provider = new EngineProvider({ resolve: t => tokens.resolve(t), isEngineConnection: () => direct });
  const target = board => ({ resources: ['https://x/b/b1/mcp'], ...(board ? { board } : {}) });

  const ok = provider.bearer(token, target('b1'));
  assert.equal(ok.kind, 'ok');
  assert.deepEqual([ok.identity.provider, ok.identity.subject, ok.identity.board, ok.identity.via, ok.identity.role, ok.identity.issuer], ['engine', 'fullfran', 'b1', 'bearer', undefined, undefined]);
  assert.equal(provider.bearer(token, target('b2')).kind, 'invalid', 'another board');
  assert.equal(provider.bearer(token, target(undefined)).kind, 'invalid', 'no board named');
  assert.equal(provider.bearer(`${token}0`, target('b1')).kind, 'invalid', 'unknown token');
  assert.equal(provider.bearer('other-token', target('b1')).kind, 'none', 'not an engine token: left to the other providers');
  assert.equal(provider.session?.(new Map(), target('b1')), undefined, 'never a session');
  direct = false;
  assert.equal(provider.bearer(token, target('b1')).kind, 'invalid', 'not a direct loopback connection');
  direct = true;
  tokens.revoke(token);
  assert.equal(provider.bearer(token, target('b1')).kind, 'invalid', 'revoked');
});

test('agent policy: tools/call outside the list is refused, the rest of the protocol is left alone', () => {
  const allowed = new Set(AGENT_TOOLS);
  const call = name => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name } });
  const verdict = (body, headers = {}) => agentRequestVerdict(Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)), headers, allowed);
  assert.deepEqual(verdict(call('batch_create_elements')), { ok: true });
  assert.deepEqual(verdict({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), { ok: true }, 'tools/list is not filtered');
  assert.deepEqual(verdict({ jsonrpc: '2.0', method: 'notifications/initialized' }), { ok: true });
  for (const name of ['clear_canvas', 'import_scene', 'restore_snapshot', 'export_to_image', 'set_viewport', 'some_future_tool', '']) {
    const refused = verdict(call(name));
    assert.equal(refused.ok, false, name);
    assert.equal(refused.status, 403);
  }
  assert.equal(verdict([call('describe_scene'), call('clear_canvas')]).ok, false, 'one bad call in a batch');
  assert.equal(verdict('not json').status, 400);
  assert.equal(verdict('[]').status, 400);
  assert.equal(verdict('[1]').status, 400);
  assert.equal(verdict(call('describe_scene'), { contentEncoding: 'gzip' }).status, 415);
  assert.equal(verdict(call('describe_scene'), { contentType: 'application/json; charset=utf-16' }).status, 415);
  assert.equal(verdict(call('describe_scene'), { mcpMethod: 'tools/call', mcpName: 'clear_canvas' }).status, 403);
  assert.deepEqual(verdict(call('describe_scene'), { mcpMethod: 'tools/call', mcpName: 'describe_scene' }), { ok: true });
  for (const tool of ['clear_canvas', 'import_scene', 'restore_snapshot', 'set_viewport']) assert.ok(!AGENT_TOOLS.includes(tool), tool);
  assert.match(AGENT_SYSTEM_PROMPT, /batch_create_elements/);
  assert.match(AGENT_SYSTEM_PROMPT, /[Nn]ever clear/);
});

function setup(overrides = {}) {
  const dir = tempDir();
  const vault = new CredentialVault(dir, KEY);
  const tokens = new EngineTokens();
  const hubEvents = [];
  const hub = new AgentHub();
  hub.subscribe('b1', event => hubEvents.push(event));
  hub.subscribe('b2', event => hubEvents.push({ ...event, board: 'b2' }));
  const manager = new AgentManager({
    vault, tokens, hub, mcpUrl: board => `http://127.0.0.1:1/b/${board}/mcp`, maxProcesses: 2, entry: FAKE_ENGINE,
    abortGraceMs: 500, replyTimeoutMs: 3000, ...overrides
  });
  return { dir, vault, tokens, hub, hubEvents, manager };
}

function collect() {
  const events = [];
  return { events, sink: { event: (name, data) => events.push([name, data]) } };
}

test('manager: a device login stores the credential, a turn streams text, tools and drafts, then ends', async t => {
  const { manager, vault, hubEvents } = setup();
  t.after(() => manager.close());
  assert.deepEqual(manager.status('fullfran', 'b1'), { connected: false, busy: false, pending: null });
  await assert.rejects(async () => manager.prompt('fullfran', 'b1', 'draw', collect().sink), error => error instanceof EngineError && error.code === 'not_connected');

  const login = await manager.startLogin('fullfran', 'b1');
  assert.deepEqual(login, { userCode: 'FAKE-1234', verificationUri: 'https://auth.openai.com/codex/device' });
  assert.deepEqual(manager.status('fullfran', 'b1').pending, login);
  assert.equal(manager.status('fullfran', 'b2').pending, null, 'another board does not show the code');
  for (let i = 0; i < 50 && !vault.read('fullfran'); i += 1) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(vault.read('fullfran')?.refresh, 'fake-refresh-0');
  assert.deepEqual(manager.status('fullfran', 'b1'), { connected: true, busy: false, pending: null });

  const { events, sink } = collect();
  await manager.prompt('fullfran', 'b1', 'draw', sink);
  assert.deepEqual(events.map(([name]) => name), ['thinking', 'delta', 'tool', 'tool', 'delta', 'done']);
  assert.deepEqual(events[2][1], { call: 1, name: 'batch_create_elements', phase: 'start', ok: true }, 'the MCP prefix is gone');
  assert.deepEqual(events.at(-1), ['done', { aborted: false }]);

  const kinds = hubEvents.map(event => event.event);
  assert.deepEqual(kinds, ['agent', 'draft', 'draft', 'draft.end', 'agent']);
  assert.deepEqual(hubEvents[0].data, { state: 'working', login: 'fullfran' });
  assert.match(hubEvents[1].data.id, /^[a-z0-9-]{1,40}$/);
  assert.match(hubEvents[1].data.id, /-1$/);
  assert.equal(hubEvents[2].data.id, hubEvents[1].data.id, 'the same call replaces its own preview');
  assert.deepEqual(hubEvents[1].data.elements, [{ type: 'rectangle', x: 10, y: 20, width: 100, height: 50, backgroundColor: '#a5d8ff' }], 'only drawing properties survive');
  assert.deepEqual(hubEvents[2].data.elements.map(e => e.type), ['rectangle', 'ellipse'], 'a bogus shape is dropped');
  assert.equal(hubEvents[3].data.id, hubEvents[1].data.id);
  assert.deepEqual(hubEvents[4].data, { state: 'idle', login: 'fullfran' });
});

test('manager: the cap answers busy, a pending login gives way to a turn, ids differ between engines', async t => {
  const { manager, vault, hubEvents } = setup({ maxProcesses: 1 });
  t.after(() => manager.close());
  vault.write('fullfran', credential);
  vault.write('other', credential);
  const first = collect();
  const running = manager.prompt('fullfran', 'b1', 'hang', first.sink);
  assert.equal(manager.status('fullfran', 'b1').busy, true);
  assert.throws(() => manager.prompt('fullfran', 'b1', 'draw', collect().sink), error => error.code === 'turn_in_progress');
  assert.throws(() => manager.prompt('other', 'b2', 'draw', collect().sink), error => error.code === 'busy');
  await assert.rejects(manager.startLogin('other', 'b2'), error => error.code === 'busy');
  assert.ok(manager.abort('fullfran', 'b1'));
  await running;
  assert.deepEqual(first.events.at(-1), ['done', { aborted: true }]);
  assert.equal(manager.liveCount(), 1, 'the process stays for the next turn');
  // The slot frees when the idle process is stopped; a second person then gets one.
  manager.disconnect('fullfran');
  assert.equal(manager.liveCount(), 0);
  await manager.prompt('other', 'b2', 'draw', collect().sink);
  const ids = hubEvents.filter(event => event.event === 'draft').map(event => event.data.id);
  assert.ok(ids.length >= 1 && ids.every(id => /^[a-z0-9]{8}-\d+$/.test(id)));
});

test('manager: two boards of one person are two processes with different draft ids', async t => {
  const { manager, vault, hubEvents } = setup();
  t.after(() => manager.close());
  vault.write('fullfran', credential);
  await Promise.all([manager.prompt('fullfran', 'b1', 'draw', collect().sink), manager.prompt('fullfran', 'b2', 'draw', collect().sink)]);
  const byBoard = board => new Set(hubEvents.filter(e => e.event === 'draft' && (e.board ?? 'b1') === board).map(e => e.data.id));
  const [one] = byBoard('b1');
  const [two] = byBoard('b2');
  assert.ok(one && two && one !== two);
});

test('manager: lines that are not valid protocol messages are dropped, tools outside the list never reach the browser', async t => {
  const { manager, vault } = setup();
  t.after(() => manager.close());
  vault.write('fullfran', credential);
  const { events, sink } = collect();
  await manager.prompt('fullfran', 'b1', 'garbage', sink);
  assert.deepEqual(events, [['delta', { text: 'still alive' }], ['done', { aborted: false }]]);
});

test('manager: an engine that offers a tool outside the list is stopped, one that dies takes its previews down', async t => {
  const { manager, vault, hubEvents, tokens } = setup();
  t.after(() => manager.close());
  vault.write('fullfran', credential);
  const bad = collect();
  await manager.prompt('fullfran', 'b1', 'badtools', bad.sink);
  assert.deepEqual(bad.events, [['error', { code: 'engine_unavailable' }]]);
  assert.equal(manager.liveCount(), 0);
  assert.equal(tokens.size, 0, 'its token is revoked');

  hubEvents.length = 0;
  const dying = collect();
  await manager.prompt('fullfran', 'b1', 'die', dying.sink);
  assert.deepEqual(dying.events, [['error', { code: 'engine_unavailable' }]]);
  assert.deepEqual(hubEvents.map(e => e.event), ['agent', 'draft', 'draft.end', 'agent'], 'the open preview is retired');
  assert.equal(hubEvents[2].data.id, hubEvents[1].data.id);
});

test('manager: a turn over its time limit ends as turn_limit', async t => {
  const { manager, vault } = setup({ turnTimeoutMs: 100 });
  t.after(() => manager.close());
  vault.write('fullfran', credential);
  const { events, sink } = collect();
  await manager.prompt('fullfran', 'b1', 'hang', sink);
  assert.deepEqual(events, [['error', { code: 'turn_limit' }]]);
});

test('manager: a login is rate limited, and logout deletes the credential and stops the engines', async t => {
  const { manager, vault } = setup({ loginLimit: 2 });
  t.after(() => manager.close());
  await manager.startLogin('fullfran', 'b1');
  await manager.startLogin('fullfran', 'b1');
  await assert.rejects(manager.startLogin('fullfran', 'b1'), error => error.code === 'rate_limited');
  for (let i = 0; i < 50 && !vault.read('fullfran'); i += 1) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(vault.read('fullfran'));
  await manager.prompt('fullfran', 'b1', 'draw', collect().sink);
  manager.disconnect('fullfran');
  assert.equal(vault.read('fullfran'), null);
  assert.equal(manager.liveCount(), 0);
  assert.deepEqual(manager.status('fullfran', 'b1'), { connected: false, busy: false, pending: null });
});

test('manager: close stops every process and refuses new work', async () => {
  const { manager, vault } = setup();
  vault.write('fullfran', credential);
  const running = manager.prompt('fullfran', 'b1', 'hang', collect().sink);
  await manager.close();
  await running;
  assert.equal(manager.liveCount(), 0);
  assert.throws(() => manager.prompt('fullfran', 'b1', 'draw', collect().sink), error => error.code === 'engine_unavailable');
});

test('manager: the model list comes from the engine, and a turn carries the choice and reports what it used', async t => {
  const { manager, vault } = setup();
  t.after(() => manager.close());
  await assert.rejects(manager.models('fullfran', 'b1'), error => error instanceof EngineError && error.code === 'not_connected');
  await manager.startLogin('fullfran', 'b1');
  for (let i = 0; i < 50 && !vault.read('fullfran'); i += 1) await new Promise(resolve => setTimeout(resolve, 20));

  const [first, second] = await Promise.all([manager.models('fullfran', 'b1'), manager.models('fullfran', 'b1')]);
  assert.deepEqual(first, [
    { id: 'gpt-fake-a', name: 'Fake A', levels: ['off', 'low', 'high'] },
    { id: 'gpt-fake-b', name: 'gpt-fake-b', levels: ['off'] },
  ], 'levels in pi\'s order; a name that is not plain text becomes the id');
  assert.deepEqual(second, first, 'two callers share one request');

  const { events, sink } = collect();
  await manager.prompt('fullfran', 'b1', 'choice', sink, { model: 'gpt-fake-b', thinking: 'max' });
  assert.deepEqual(events, [['settings', { model: 'gpt-fake-b', thinking: 'high' }], ['done', { aborted: false }]], 'the choice reaches the engine; a malformed settings line is dropped');
});
