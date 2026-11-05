#!/usr/bin/env node
// Checks for boards (docs/multiuser.md, issues #11 and #5): one upstream
// canvas per open board behind `/b/<id>/...`, per-board MCP and RFC 8707
// resources, idle stop and reopen, the open-board cap, the migration of
// today's canvas to board `main` (with `/mcp` and the unprefixed paths as its
// alias), invites by GitHub login and the viewer role. Real `dist/main.js`
// gateways, a fake GitHub; scratch state outside the repository, kept and
// printed on failure, removed on success.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import {
  assert, assertEqual, childPids, cookieHeader, freePort, githubEnv, githubLogin, killAll, mcpCall, mcpToolsList, obtainToken,
  request, sleep, startFakeGitHub, startGateway, waitFor, wsOpen
} from './lib/harness.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'pizarra-boards-check-'));
let passed = 0;
function ok(label) { passed += 1; console.log(`  ok - ${label}`); }

const element = (id, extra = {}) => ({ id, type: 'rectangle', x: 1, y: 2, width: 30, height: 40, ...extra });

async function elementIds(base, prefix, headers = {}) {
  const response = await request(base, { path: `${prefix}/api/elements`, headers });
  assertEqual(response.status, 200, `GET ${prefix}/api/elements (${response.text.slice(0, 200)})`);
  return (response.body.elements ?? []).map(e => e.id).sort();
}

async function checkTwoBoards() {
  const dataDir = join(scratch, 'two');
  const gateway = await startGateway(scratch, { EXCALIDRAW_DATA_DIR: dataDir });
  const { base } = gateway;
  try {
    for (const [id, name] of [['alpha', 'Alpha'], ['beta', 'Beta']]) {
      const created = await request(base, { method: 'POST', path: '/boards', json: { id, name } });
      assertEqual(created.status, 201, `create board ${id} (${created.text})`);
      assertEqual(created.body.board.id, id, 'created board id');
    }
    assertEqual((await request(base, { method: 'POST', path: '/boards', json: { id: 'alpha', name: 'again' } })).status, 409, 'a duplicate board id');
    assertEqual((await request(base, { method: 'POST', path: '/boards', json: { id: 'Bad/Id' } })).status, 400, 'an invalid board id');
    const list = await request(base, { path: '/boards' });
    assertEqual(JSON.stringify(list.body.boards.map(b => b.id)), '["alpha","beta","main"]', 'GET /boards lists main and the new boards');

    // REST on one board never shows on the other, nor on main (the unprefixed alias).
    assertEqual((await request(base, { method: 'POST', path: '/b/alpha/api/elements', json: element('on-alpha') })).status, 200, 'REST create on alpha');
    assertEqual(JSON.stringify(await elementIds(base, '/b/alpha')), '["on-alpha"]', 'alpha has its element');
    assertEqual(JSON.stringify(await elementIds(base, '/b/beta')), '[]', 'beta does not see alpha\'s element');
    assertEqual(JSON.stringify(await elementIds(base, '')), '[]', 'main does not see alpha\'s element');
    // MCP on one board never shows on the other.
    const call = await mcpCall(base, '/b/beta/mcp', 'create_element', element('on-beta-mcp', { type: 'ellipse' }));
    assert(call.result?.result && !call.result.result.isError, `create_element over /b/beta/mcp: ${call.text.slice(0, 300)}`);
    assertEqual(JSON.stringify(await elementIds(base, '/b/beta')), '["on-beta-mcp"]', 'the MCP write lands on beta');
    assertEqual((await request(base, { path: '/b/alpha/api/elements/on-beta-mcp' })).status, 404, 'alpha does not see beta\'s MCP element');
    const described = await mcpCall(base, '/b/alpha/mcp', 'query_elements', {});
    assert(described.text.includes('on-alpha') && !described.text.includes('on-beta-mcp'), `alpha's MCP reads only alpha: ${described.text.slice(0, 300)}`);
    // The unprefixed paths and /mcp are board main.
    await mcpCall(base, '/mcp', 'create_element', element('on-main-mcp'));
    assertEqual(JSON.stringify(await elementIds(base, '/b/main')), '["on-main-mcp"]', '/mcp writes to board main');
    assertEqual(JSON.stringify(await elementIds(base, '')), '["on-main-mcp"]', 'unprefixed /api is board main');
    // Browser: each board's WebSocket starts from that board's elements.
    const wsAlpha = await wsOpen(`ws://127.0.0.1:${gateway.port}/b/alpha/`);
    assert(wsAlpha.ok, `WebSocket on /b/alpha/: ${wsAlpha.status}`);
    assertEqual(JSON.stringify(wsAlpha.messages[0].elements.map(e => e.id)), '["on-alpha"]', 'alpha\'s WebSocket sends alpha\'s elements');
    const wsBeta = await wsOpen(`ws://127.0.0.1:${gateway.port}/b/beta/`);
    assertEqual(JSON.stringify(wsBeta.messages[0].elements.map(e => e.id)), '["on-beta-mcp"]', 'beta\'s WebSocket sends beta\'s elements');
    // A live write on alpha is broadcast to alpha's browsers only.
    const live = await wsOpen(`ws://127.0.0.1:${gateway.port}/b/beta/`, {}, { keep: true });
    const seen = [];
    live.socket.on('message', data => seen.push(JSON.parse(String(data))));
    await request(base, { method: 'POST', path: '/b/alpha/api/elements', json: element('alpha-live') });
    await sleep(500);
    live.socket.close();
    assert(!seen.some(m => JSON.stringify(m).includes('alpha-live')), 'a write on alpha is never broadcast on beta');

    // The board page is the upstream UI with the gateway's board script; assets are shared.
    const page = await request(base, { path: '/b/alpha/' });
    assertEqual(page.status, 200, 'board page');
    assert(/<script src="\/__pizarra\/board\.js"[^>]*data-board="alpha"/.test(page.text), `the board page loads the board script: ${page.text.slice(-600)}`);
    const asset = /src="(\/assets\/[^"]+\.js)"/.exec(page.text)?.[1];
    assert(asset, 'the board page references the upstream bundle');
    assertEqual((await request(base, { path: asset })).status, 200, 'upstream assets are served unprefixed for every board');
    const script = await request(base, { path: '/__pizarra/board.js' });
    assertEqual(script.status, 200, 'board script');
    assert(/javascript/.test(script.headers['content-type']) && script.text.includes('/b/'), 'board script rewrites API and WebSocket paths');
    assertEqual((await request(base, { path: '/b/alpha' })).headers.location, '/b/alpha/', '/b/<id> redirects to /b/<id>/');
    assertEqual((await request(base, { path: '/b/nope/api/elements' })).status, 404, 'an unknown board');
    assertEqual((await request(base, { path: '/b/nope/mcp', method: 'POST', json: {} })).status, 404, 'an unknown board has no MCP');

    // One upstream process per open board, each with its own data and export directories.
    const pids = childPids(gateway.child.pid);
    assert(pids.length >= 3, `main, alpha and beta run as their own processes (children: ${pids.join(' ')})`);
    for (const id of ['alpha', 'beta', 'main']) {
      assert(existsSync(join(dataDir, 'boards', id, 'canvas', 'canvas-state-v1.json')), `${id} keeps its canvas in boards/${id}/canvas`);
      assert(existsSync(join(dataDir, 'boards', id, 'files')), `${id} has its own export directory`);
    }
    const environs = pids.map(pid => readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0'));
    assert(environs.some(env => env.includes(`EXCALIDRAW_DATA_DIR=${join(dataDir, 'boards', 'alpha', 'canvas')}`)), 'alpha\'s process gets only alpha\'s directory');
    assertEqual(statSync(join(dataDir, 'boards.json')).mode & 0o777, 0o600, 'boards.json is private');
    ok('two boards open at once: REST, MCP and WebSocket writes on one never show on the other; /mcp and unprefixed paths are main');
  } finally {
    await gateway.stop();
  }
}

async function checkIdleAndCap() {
  const dataDir = join(scratch, 'idle');
  const gateway = await startGateway(scratch, { EXCALIDRAW_DATA_DIR: dataDir, BOARD_IDLE_SECONDS: '2', MAX_OPEN_BOARDS: '2' });
  const { base } = gateway;
  try {
    await request(base, { method: 'POST', path: '/boards', json: { id: 'sleepy' } });
    await request(base, { method: 'POST', path: '/b/sleepy/api/elements', json: element('kept') });
    const before = childPids(gateway.child.pid).length;
    await waitFor(() => childPids(gateway.child.pid).length < before, 15000, 'the idle board stops');
    assertEqual(JSON.stringify(await elementIds(base, '/b/sleepy')), '["kept"]', 'the reopened board has its elements');
    ok('an idle board stops and reopens with its elements intact');

    for (const id of ['one', 'two']) {
      await request(base, { method: 'POST', path: '/boards', json: { id } });
      await request(base, { method: 'POST', path: `/b/${id}/api/elements`, json: element(`on-${id}`) });
    }
    assert(childPids(gateway.child.pid).length <= 2, `at most MAX_OPEN_BOARDS=2 canvases run (children: ${childPids(gateway.child.pid).join(' ')})`);
    assertEqual(JSON.stringify(await elementIds(base, '/b/one')), '["on-one"]', 'an evicted board reopens with its elements');
    ok('open boards are capped: the least recently used idle board is stopped to open another');
  } finally {
    await gateway.stop();
  }
}

/** Writes an old-layout data directory (<data>/canvas, <data>/files) with the upstream canvas itself. */
async function oldLayout(dataDir) {
  mkdirSync(join(dataDir, 'files'), { recursive: true, mode: 0o700 });
  writeFileSync(join(dataDir, 'files', 'old.excalidraw'), '{}');
  const require = createRequire(import.meta.url);
  const entry = require.resolve('mcp-excalidraw-server/dist/server.js');
  const port = await freePort();
  const child = spawn(process.execPath, [entry], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, HOST: '127.0.0.1', PORT: String(port), EXCALIDRAW_DATA_DIR: join(dataDir, 'canvas'), EXCALIDRAW_NO_AUTOSTART: '1', XDG_STATE_HOME: scratch },
    stdio: 'ignore'
  });
  const url = `http://127.0.0.1:${port}`;
  await waitFor(async () => { try { return (await fetch(`${url}/health`)).ok; } catch { return false; } }, 15000, 'old canvas up');
  const created = await fetch(`${url}/api/elements`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(element('from-before')) });
  assert(created.ok, 'element written in the old layout');
  await sleep(300);
  child.kill('SIGTERM');
  await waitFor(() => child.exitCode !== null || child.signalCode !== null, 8000, 'old canvas stops');
  assert(existsSync(join(dataDir, 'canvas', 'canvas-state-v1.json')), 'the old layout has a canvas checkpoint');
}

async function checkMigrationAndAuth() {
  const github = await startFakeGitHub();
  const dataDir = join(scratch, 'migrated');
  await oldLayout(dataDir);
  const port = await freePort();
  const env = githubEnv(port, github.url, dataDir, { PORT: String(port) });
  let gateway = await startGateway(scratch, env);
  const { base } = gateway;
  try {
    assert(!existsSync(join(dataDir, 'canvas')) && existsSync(join(dataDir, 'boards', 'main', 'canvas', 'canvas-state-v1.json')), 'the canvas moved to boards/main/canvas');
    assert(existsSync(join(dataDir, 'boards', 'main', 'files', 'old.excalidraw')) && !existsSync(join(dataDir, 'files')), 'the export directory moved to boards/main/files');

    const admin = await githubLogin(base, github, 'FullFran');
    assert(admin.jar, `admin signs in (${admin.poll.text})`);
    const cookie = { cookie: cookieHeader(admin.jar) };
    assertEqual(JSON.stringify(await elementIds(base, '', cookie)), '["from-before"]', 'the old canvas is board main, at the unprefixed paths');
    assertEqual(JSON.stringify(await elementIds(base, '/b/main', cookie)), '["from-before"]', 'and at /b/main');

    const createdA = await request(base, { method: 'POST', path: '/boards', headers: { ...cookie, origin: base }, json: { id: 'alpha', name: 'Alpha board' } });
    assertEqual(createdA.status, 201, `admin creates alpha (${createdA.text})`);
    assertEqual((await request(base, { method: 'POST', path: '/boards', headers: cookie, json: { id: 'csrf' } })).status, 403, 'board creation with the cookie needs our Origin');
    await request(base, { method: 'POST', path: '/boards', headers: { ...cookie, origin: base }, json: { id: 'beta' } });

    // Per-board resources: discovery, consent naming the board, audience binding.
    const anonymous = await mcpToolsList(base, '/b/alpha/mcp');
    assertEqual(anonymous.status, 401, '/b/alpha/mcp without a token');
    assertEqual(anonymous.headers['www-authenticate'], `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/b/alpha/mcp", scope="whiteboard"`, 'per-board challenge');
    const prm = await request(base, { path: '/.well-known/oauth-protected-resource/b/alpha/mcp' });
    assertEqual(prm.body?.resource, `${base}/b/alpha/mcp`, 'per-board protected resource metadata');
    assertEqual((await request(base, { path: '/.well-known/oauth-protected-resource/b/nope/mcp' })).status, 404, 'no metadata for an unknown board');
    const tokenA = await obtainToken(base, admin.jar, `${base}/b/alpha/mcp`);
    assert(tokenA.page.text.includes('Alpha board'), 'the consent page names the board');
    const bearerA = { authorization: `Bearer ${tokenA.accessToken}` };
    assertEqual((await mcpToolsList(base, '/b/alpha/mcp', bearerA)).status, 200, 'a token for alpha opens /b/alpha/mcp');
    assertEqual((await mcpToolsList(base, '/b/beta/mcp', bearerA)).status, 401, 'a token for alpha is rejected on /b/beta/mcp');
    assertEqual((await mcpToolsList(base, '/mcp', bearerA)).status, 401, 'a token for alpha is rejected on /mcp');
    assertEqual((await request(base, { path: '/b/beta/api/elements', headers: bearerA })).status, 401, 'a token for alpha is rejected on beta\'s REST API');
    assertEqual((await request(base, { path: '/b/alpha/api/elements', headers: bearerA })).status, 200, 'a token for alpha opens alpha\'s REST API');
    const wrong = await request(base, { path: `/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: tokenA.clientId, redirect_uri: 'http://127.0.0.1:43123/callback', code_challenge: 'x'.repeat(43), code_challenge_method: 'S256', resource: `${base}/b/nope/mcp` })}`, headers: cookie });
    assertEqual(new URL(wrong.headers.location).searchParams.get('error'), 'invalid_target', 'a token for an unknown board is not issued');

    // A token for /mcp (what existing agents hold) keeps working, also across a restart.
    const legacy = await obtainToken(base, admin.jar);
    const bearer = { authorization: `Bearer ${legacy.accessToken}` };
    assertEqual((await mcpToolsList(base, '/mcp', bearer)).status, 200, 'a /mcp token opens /mcp');
    assertEqual((await request(base, { path: '/api/elements', headers: bearer })).status, 200, 'a /mcp token opens main\'s unprefixed REST API');
    assertEqual((await request(base, { path: '/b/main/api/elements', headers: bearer })).status, 200, 'a /mcp token opens /b/main/api');
    assertEqual((await mcpToolsList(base, '/b/alpha/mcp', bearer)).status, 401, 'a /mcp token does not open another board');
    await gateway.stop();
    gateway = await startGateway(scratch, env);
    assertEqual((await mcpToolsList(base, '/mcp', bearer)).status, 200, 'the /mcp token still works after a restart');
    assertEqual(JSON.stringify(await elementIds(base, '', bearer)), '["from-before"]', 'main keeps its elements after the restart');
    const refreshed = await request(base, { method: 'POST', path: '/oauth/token', form: { grant_type: 'refresh_token', refresh_token: legacy.refreshToken, client_id: legacy.clientId } });
    assertEqual(refreshed.status, 200, `a /mcp refresh token renews (${refreshed.text})`);
    assertEqual((await mcpToolsList(base, '/mcp', { authorization: `Bearer ${refreshed.body.access_token}` })).status, 200, 'the renewed token opens /mcp');
    ok('migration: the old canvas and export directory become board main; /mcp tokens keep working; a token for board A is rejected on /b/B/mcp');
  } finally {
    await gateway.stop();
    await github.close();
  }
}

async function checkInvitesAndViewers() {
  const github = await startFakeGitHub();
  const dataDir = join(scratch, 'invites');
  const port = await freePort();
  const gateway = await startGateway(scratch, githubEnv(port, github.url, dataDir, { PORT: String(port) }));
  const { base } = gateway;
  try {
    const admin = await githubLogin(base, github, 'FullFran');
    const adminCookie = { cookie: cookieHeader(admin.jar), origin: base };
    for (const id of ['alpha', 'beta']) await request(base, { method: 'POST', path: '/boards', headers: adminCookie, json: { id } });
    const before = await githubLogin(base, github, 'alice');
    assertEqual(before.poll.body?.reason, 'not_allowed', 'an account that is no admin nor member cannot sign in');

    // Owners (admins) invite GitHub logins as editors or viewers.
    assertEqual((await request(base, { method: 'PUT', path: '/b/alpha/members/alice', headers: { cookie: adminCookie.cookie }, json: { role: 'editor' } })).status, 403, 'an invite with the cookie needs our Origin');
    assertEqual((await request(base, { method: 'PUT', path: '/b/alpha/members/alice', headers: adminCookie, json: { role: 'owner' } })).status, 400, 'owner is not an invitable role');
    assertEqual((await request(base, { method: 'PUT', path: '/b/alpha/members/alice', headers: adminCookie, json: { role: 'editor' } })).status, 200, 'invite alice as editor');
    const invited = await request(base, { method: 'PUT', path: '/b/alpha/members/Bob', headers: adminCookie, json: { role: 'viewer' } });
    assertEqual(JSON.stringify(invited.body.members), '[{"login":"alice","role":"editor"},{"login":"bob","role":"viewer"}]', 'members after the invites');
    const stored = JSON.parse(readFileSync(join(dataDir, 'boards.json'), 'utf8')).boards.alpha.members;
    assertEqual(JSON.stringify(stored), '{"alice":"editor","bob":"viewer"}', 'memberships are written to boards.json');

    // An editor: signs in now, sees only alpha, draws on it, cannot invite or create boards.
    const alice = await githubLogin(base, github, 'alice');
    assert(alice.jar, `an invited login signs in (${alice.poll.text})`);
    const aliceCookie = { cookie: cookieHeader(alice.jar), origin: base };
    assertEqual(JSON.stringify((await request(base, { path: '/boards', headers: aliceCookie })).body.boards.map(b => [b.id, b.role])), '[["alpha","editor"]]', 'an editor lists only its boards');
    assertEqual((await request(base, { path: '/b/alpha/', headers: aliceCookie })).status, 200, 'an editor opens its board page');
    assertEqual((await request(base, { method: 'POST', path: '/b/alpha/api/elements', headers: aliceCookie, json: element('by-alice') })).status, 200, 'an editor writes');
    assertEqual((await request(base, { path: '/b/beta/api/elements', headers: aliceCookie })).status, 404, 'a board you are not on is a 404');
    assertEqual((await request(base, { path: '/api/elements', headers: aliceCookie })).status, 404, 'main (unprefixed) is not open to a member of another board');
    assertEqual((await request(base, { method: 'PUT', path: '/b/alpha/members/carol', headers: aliceCookie, json: { role: 'editor' } })).status, 403, 'an editor cannot invite');
    assertEqual((await request(base, { method: 'POST', path: '/boards', headers: aliceCookie, json: { id: 'mine' } })).status, 403, 'only admins create boards');

    // A viewer: reads, never writes (REST, WebSocket data frames, MCP tools).
    const bob = await githubLogin(base, github, 'bob');
    const bobCookie = { cookie: cookieHeader(bob.jar), origin: base };
    assertEqual(JSON.stringify(await elementIds(base, '/b/alpha', bobCookie)), '["by-alice"]', 'a viewer reads the board');
    for (const [method, path, json] of [['POST', '/b/alpha/api/elements', element('by-bob')], ['PUT', '/b/alpha/api/elements/by-alice', { width: 1 }], ['DELETE', '/b/alpha/api/elements/clear', undefined], ['POST', '/b/alpha/api/elements/sync', { elements: [] }]]) {
      const refused = await request(base, { method, path, headers: bobCookie, json });
      assertEqual(refused.status, 403, `a viewer cannot ${method} ${path}`);
    }
    const viewerSocket = await wsOpen(`ws://127.0.0.1:${port}/b/alpha/`, bobCookie, { keep: true });
    assert(viewerSocket.ok, `a viewer opens the WebSocket (${viewerSocket.status})`);
    const afterFrames = await new Promise(resolve => {
      const socket = viewerSocket.socket;
      const seen = [];
      socket.on('message', data => seen.push(JSON.parse(String(data))));
      socket.send(JSON.stringify({ type: 'elements_batch_created', elements: [element('ws-injected')] }));
      socket.send(Buffer.from('binary frame'));
      socket.ping();
      socket.once('pong', async () => {
        await request(base, { method: 'POST', path: '/b/alpha/api/elements', headers: aliceCookie, json: element('after-viewer-frames') });
        await sleep(500);
        socket.close();
        resolve({ open: true, seen });
      });
      setTimeout(() => resolve({ open: false, seen }), 5000);
    });
    assert(afterFrames.open, 'control frames (ping/pong) pass for a viewer');
    assert(afterFrames.seen.some(m => JSON.stringify(m).includes('after-viewer-frames')), 'the viewer keeps receiving live updates after sending data frames');
    assertEqual(JSON.stringify(await elementIds(base, '/b/alpha', bobCookie)), '["after-viewer-frames","by-alice"]', 'nothing a viewer sent changed the board');
    const bobToken = await obtainToken(base, bob.jar, `${base}/b/alpha/mcp`);
    const bobBearer = { authorization: `Bearer ${bobToken.accessToken}` };
    const write = await mcpCall(base, '/b/alpha/mcp', 'create_element', element('by-bob-mcp'), bobBearer);
    assertEqual(write.status, 403, `a viewer's agent cannot call create_element (${write.text.slice(0, 200)})`);
    assert(/read-only/.test(write.body?.error?.message ?? ''), 'the refusal says the board is read-only');
    const read = await mcpCall(base, '/b/alpha/mcp', 'query_elements', {}, bobBearer);
    assert(read.result?.result && read.text.includes('by-alice'), `a viewer's agent reads (${read.text.slice(0, 200)})`);
    assertEqual((await request(base, { path: '/b/alpha/api/elements/by-bob-mcp', headers: bobCookie })).status, 404, 'the refused MCP write did not happen');

    // Removing a member ends their access at once (sessions and tokens).
    assertEqual((await request(base, { method: 'DELETE', path: '/b/alpha/members/bob', headers: adminCookie })).status, 200, 'remove bob');
    assertEqual((await request(base, { path: '/b/alpha/api/elements', headers: bobCookie })).status, 401, 'a removed member\'s session no longer works');
    assertEqual((await mcpToolsList(base, '/b/alpha/mcp', bobBearer)).status, 401, 'a removed member\'s token no longer works');
    ok('invites by GitHub login: editors draw, viewers only read (REST 403, WebSocket data frames dropped, read-only MCP tools); removal ends access');
  } finally {
    await gateway.stop();
    await github.close();
  }
}

try {
  console.log(`Board checks (scratch: ${scratch})`);
  await checkTwoBoards();
  await checkIdleAndCap();
  await checkMigrationAndAuth();
  await checkInvitesAndViewers();
  console.log(`Board check passed: ${passed} groups.`);
} catch (error) {
  console.error(`Board check failed after ${passed} groups: ${error.stack || error.message}`);
  console.error(`scratch kept: ${scratch}`);
  process.exitCode = 1;
} finally {
  killAll();
}
if (process.exitCode !== 1 && existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
process.exit(process.exitCode ?? 0);
