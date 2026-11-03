#!/usr/bin/env node
// Checks for the gateway's supervision of the upstream canvas: it runs on an
// internal loopback port with an environment stripped of the gateway's
// settings (only its own durable-state directory is passed), is restarted
// after a crash (/health says 503 meanwhile), stops with the gateway
// (SIGTERM), and exits by itself when the gateway is killed (SIGKILL), so no
// canvas process is ever left behind. The canvas survives a canvas crash, a
// gateway restart and a gateway SIGKILL when the data directory is kept. Real `dist/main.js`
// processes; scratch state outside the repository, removed on success.

import { spawn } from 'node:child_process';
import net from 'node:net';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const mainPath = join(repoRoot, 'dist', 'main.js');
const scratch = mkdtempSync(join(tmpdir(), 'pizarra-proxy-check-'));
const spawned = new Set();
let passed = 0;

function killAll() {
  for (const child of spawned) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}
process.on('exit', killAll);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function assert(condition, message) { if (!condition) throw new Error(message); }
function ok(label) { passed += 1; console.log(`  ok - ${label}`); }

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
  });
}

/** Running (a zombie waiting to be reaped by whoever adopted it counts as gone). */
function processAlive(pid) {
  try { process.kill(pid, 0); } catch { return false; }
  try { return !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return false; }
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(100);
  }
  throw new Error(`timed out: ${label}`);
}

async function json(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
    return { status: response.status, body: await response.json().catch(() => null) };
  } catch {
    return { status: 0, body: null };
  }
}

async function startGateway(extraEnv = {}) {
  const port = await freePort();
  const internalPort = await freePort();
  const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', CANVAS_INTERNAL_PORT: String(internalPort), LOG_LEVEL: 'warn', XDG_STATE_HOME: scratch, LOG_FILE_PATH: join(scratch, `gateway-${port}.log`), ...extraEnv };
  for (const name of ['EXPRESS_SERVER_URL', 'TRUST_PROXY']) delete env[name];
  for (const name of ['AUTH_MODE', 'PUBLIC_BASE_URL', 'EXCALIDRAW_DATA_DIR', 'CANVAS_DATA_DIR', 'EXCALIDRAW_EXPORT_DIR']) if (!(name in extraEnv)) delete env[name];
  const child = spawn(process.execPath, [mainPath], { cwd: scratch, env, stdio: ['ignore', 'pipe', 'pipe'] });
  spawned.add(child);
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const base = `http://127.0.0.1:${port}`;
  await waitFor(async () => {
    if (child.exitCode !== null) throw new Error(`gateway exited: ${output}`);
    return (await json(`${base}/health`)).status === 200;
  }, 15000, `gateway healthy (${output})`);
  const upstream = await json(`http://127.0.0.1:${internalPort}/health`);
  assert(upstream.body?.service === 'mcp-excalidraw-canvas' && upstream.body.pid > 0, 'upstream answers on its internal port');
  return { child, base, internalPort, upstreamPid: upstream.body.pid, upstreamHealth: upstream.body, output: () => output };
}

async function checkEnvironmentAndRestart() {
  const secret = randomBytes(36).toString('base64');
  const port = await freePort();
  const dataDir = join(scratch, `data-${port}`);
  const gateway = await startGateway({
    AUTH_MODE: 'oauth', PUBLIC_BASE_URL: 'http://127.0.0.1:1', GITHUB_CLIENT_ID: 'gh-proxy-check', ALLOWED_GITHUB_LOGINS: 'FullFran',
    AUTH_SECRET: secret, EXCALIDRAW_DATA_DIR: dataDir
  });
  const environ = readFileSync(`/proc/${gateway.upstreamPid}/environ`, 'utf8').split('\0');
  for (const name of ['AUTH_SECRET', 'GITHUB_CLIENT_ID', 'ALLOWED_GITHUB_LOGINS', 'PUBLIC_BASE_URL', 'AUTH_MODE']) {
    assert(!environ.some(entry => entry.startsWith(`${name}=`)), `upstream environment must not carry ${name}`);
  }
  assert(!environ.some(entry => entry.includes(secret)), 'the signing secret never reaches the upstream');
  assert(environ.includes('HOST=127.0.0.1'), 'upstream binds 127.0.0.1');
  const canvasDir = join(dataDir, 'canvas');
  assert(environ.includes(`EXCALIDRAW_DATA_DIR=${canvasDir}`), `upstream gets only its own data directory (${environ.filter(e => e.startsWith('EXCALIDRAW_DATA_DIR')).join()})`);
  assert(upstreamHealthDurable(gateway), 'upstream reports durable state enabled');
  assert(!existsSync(join(canvasDir, 'auth-store.json')) && !existsSync(join(canvasDir, 'auth-secret')), 'auth files stay out of the canvas directory');
  ok('upstream canvas runs on 127.0.0.1 with none of the gateway\'s auth settings; it gets only <data>/canvas for durable state');

  process.kill(gateway.upstreamPid, 'SIGKILL');
  await waitFor(async () => (await json(`${gateway.base}/health`)).status === 503, 5000, '/health reports the crash');
  const down = await json(`${gateway.base}/health`);
  assert(JSON.stringify(Object.keys(down.body ?? {}).sort()) === '["service","status"]', 'unhealthy /health stays minimal');
  await waitFor(async () => (await json(`${gateway.base}/health`)).status === 200, 15000, 'upstream restarted');
  const restarted = await json(`http://127.0.0.1:${gateway.internalPort}/health`);
  assert(restarted.body?.pid > 0 && restarted.body.pid !== gateway.upstreamPid, 'a new upstream process serves the canvas');
  ok('a crashed upstream canvas is restarted; /health answers 503 until it is back');

  gateway.child.kill('SIGTERM');
  await waitFor(() => gateway.child.exitCode !== null, 8000, 'gateway exits on SIGTERM');
  await waitFor(() => !processAlive(restarted.body.pid), 5000, 'upstream stops with the gateway');
  ok('SIGTERM stops the gateway and its upstream canvas');
}

function upstreamHealthDurable(gateway) {
  return gateway.upstreamHealth?.durable_state_enabled === true;
}

async function createElements(gateway, tag) {
  const rest = await fetch(`${gateway.base}/api/elements`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: `${tag}-rest`, type: 'rectangle', x: 5, y: 6, width: 70, height: 80 })
  });
  assert(rest.ok, `REST create (${rest.status})`);
  const envelope = {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientCapabilities': {},
    'io.modelcontextprotocol/clientInfo': { name: 'proxy-check', version: '0.0.0' }
  };
  const mcp = await fetch(`${gateway.base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call', 'mcp-name': 'create_element' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_element', arguments: { id: `${tag}-mcp`, type: 'ellipse', x: 1, y: 2, width: 30, height: 40 }, _meta: envelope } })
  });
  const text = await mcp.text();
  assert(mcp.ok && !/"isError":true/.test(text), `MCP create_element: ${text.slice(0, 300)}`);
}

async function expectElements(gateway, tag, label) {
  for (const [suffix, type, width] of [['rest', 'rectangle', 70], ['mcp', 'ellipse', 30]]) {
    const { status, body } = await json(`${gateway.base}/api/elements/${tag}-${suffix}`);
    assert(status === 200 && body?.element?.type === type && body.element.width === width, `${label}: ${tag}-${suffix} is still on the canvas (got ${status} ${JSON.stringify(body)?.slice(0, 200)})`);
  }
}

async function checkDurability() {
  const dataDir = join(scratch, 'durable');
  const env = { EXCALIDRAW_DATA_DIR: dataDir };
  let gateway = await startGateway(env);
  assert(upstreamHealthDurable(gateway), 'durable state enabled by EXCALIDRAW_DATA_DIR');
  await createElements(gateway, 'durable');
  assert(existsSync(join(dataDir, 'canvas', 'canvas-state-v1.json')), 'the canvas checkpoint lives in <data>/canvas');
  assert((statSync(join(dataDir, 'canvas')).mode & 0o077) === 0, 'the canvas directory is private');

  // 1. The canvas process crashes (SIGKILL: no clean shutdown) and is restarted.
  process.kill(gateway.upstreamPid, 'SIGKILL');
  await waitFor(async () => (await json(`${gateway.base}/health`)).status === 503 || !processAlive(gateway.upstreamPid), 5000, 'crash noticed');
  await waitFor(async () => (await json(`http://127.0.0.1:${gateway.internalPort}/health`)).body?.pid > 0, 15000, 'canvas restarted');
  await expectElements(gateway, 'durable', 'after a canvas crash');
  ok('elements created over REST and /mcp survive a canvas crash and restart');

  // 2. The whole gateway is restarted cleanly on the same data directory.
  gateway.child.kill('SIGTERM');
  await waitFor(() => gateway.child.exitCode !== null, 8000, 'gateway exits');
  gateway = await startGateway(env);
  await expectElements(gateway, 'durable', 'after a gateway restart');

  // 3. The gateway is SIGKILLed (its canvas exits through the guardian), then started again.
  const killedUpstream = gateway.upstreamPid;
  gateway.child.kill('SIGKILL');
  await waitFor(() => !processAlive(killedUpstream), 5000, 'orphaned canvas exits');
  gateway = await startGateway(env);
  await expectElements(gateway, 'durable', 'after a gateway SIGKILL');
  ok('elements survive a gateway restart and a gateway SIGKILL on the same data directory');

  // 4. A stale lock left by a SIGKILLed canvas whose pid is gone does not block a new gateway.
  const upstreamPid = gateway.upstreamPid;
  process.kill(upstreamPid, 'SIGKILL');
  gateway.child.kill('SIGKILL');
  await waitFor(() => !processAlive(upstreamPid) && gateway.child.signalCode !== null, 5000, 'both killed');
  assert(existsSync(join(dataDir, 'canvas', 'canvas-state.lock')), 'a hard kill leaves the canvas lock behind');
  gateway = await startGateway(env);
  assert(gateway.output().includes('Cleared a stale canvas data-directory lock'), `the gateway clears the stale lock before spawning: ${gateway.output()}`);
  const lockDir = join(dataDir, 'canvas', 'canvas-state.lock');
  const owner = JSON.parse(readFileSync(join(lockDir, readdirSync(lockDir)[0]), 'utf8'));
  assert(owner.pid === gateway.upstreamPid, `the lock now belongs to the new canvas (${JSON.stringify(owner)} vs ${gateway.upstreamPid})`);
  await expectElements(gateway, 'durable', 'after a hard kill of both');
  gateway.child.kill('SIGTERM');
  await waitFor(() => gateway.child.exitCode !== null, 8000, 'gateway exits');
  ok('a lock left by a hard-killed canvas is cleared and the canvas comes back with its elements');
}

async function startProcess(env, healthUrl, label) {
  const full = { ...process.env, LOG_LEVEL: 'warn', XDG_STATE_HOME: scratch, ...env };
  for (const name of ['EXPRESS_SERVER_URL', 'TRUST_PROXY']) delete full[name];
  for (const name of ['AUTH_MODE', 'PUBLIC_BASE_URL', 'EXCALIDRAW_DATA_DIR', 'CANVAS_DATA_DIR', 'EXCALIDRAW_EXPORT_DIR', 'CANVAS_URL', 'PIZARRA_ROLE', 'CANVAS_BIND_HOST'])
    if (!(name in env)) delete full[name];
  const child = spawn(process.execPath, [mainPath], { cwd: scratch, env: full, stdio: ['ignore', 'pipe', 'pipe'] });
  spawned.add(child);
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  if (healthUrl) {
    await waitFor(async () => {
      if (child.exitCode !== null) throw new Error(`${label} exited: ${output}`);
      return (await json(healthUrl)).status === 200;
    }, 15000, `${label} healthy (${output})`);
  }
  return { child, output: () => output };
}

async function startCanvasRole(canvasPort, dataDir) {
  const canvas = await startProcess(
    { PIZARRA_ROLE: 'canvas', CANVAS_BIND_HOST: '127.0.0.1', CANVAS_INTERNAL_PORT: String(canvasPort), EXCALIDRAW_DATA_DIR: dataDir },
    `http://127.0.0.1:${canvasPort}/health`, 'canvas role');
  const health = await json(`http://127.0.0.1:${canvasPort}/health`);
  return { ...canvas, pid: health.body?.pid };
}

async function startRemoteGateway(canvasPort, extra = {}) {
  const port = await freePort();
  const gateway = await startProcess({ PORT: String(port), HOST: '127.0.0.1', CANVAS_URL: `http://127.0.0.1:${canvasPort}`, ...extra },
    `http://127.0.0.1:${port}/health`, 'gateway with CANVAS_URL');
  return { ...gateway, base: `http://127.0.0.1:${port}` };
}

async function checkSplitCanvas() {
  const canvasPort = await freePort();
  const dataDir = join(scratch, 'split');
  let canvas = await startCanvasRole(canvasPort, dataDir);
  assert(canvas.pid > 0 && existsSync(join(dataDir, 'canvas')), 'the canvas role runs the upstream on <data>/canvas');
  const a = await startRemoteGateway(canvasPort);
  const b = await startRemoteGateway(canvasPort);
  for (const g of [a, b]) {
    const children = readFileSync(`/proc/${g.child.pid}/task/${g.child.pid}/children`, 'utf8').trim();
    assert(children === '', `a gateway with CANVAS_URL spawns no canvas of its own (children: ${children})`);
  }
  await createElements(a, 'split');
  await expectElements(b, 'split', 'seen through the other gateway');
  ok('two gateways with CANVAS_URL share one canvas run by PIZARRA_ROLE=canvas, and spawn none of their own');

  canvas.child.kill('SIGTERM');
  await waitFor(() => canvas.child.exitCode !== null, 8000, 'canvas role exits on SIGTERM');
  assert(!processAlive(canvas.pid), 'the upstream stops with the canvas role');
  // Without auth /health is the canvas's own, proxied: 502 while it is down (503 with auth on, as in production).
  await waitFor(async () => (await json(`${a.base}/health`)).status >= 500 && (await json(`${b.base}/health`)).status >= 500, 8000,
    'gateways report the canvas down');
  canvas = await startCanvasRole(canvasPort, dataDir);
  await waitFor(async () => (await json(`${a.base}/health`)).status === 200 && (await json(`${b.base}/health`)).status === 200, 15000,
    'gateways see the canvas back');
  await expectElements(a, 'split', 'after the canvas restarted');
  ok('gateways answer 5xx while the canvas is down and recover when it is back, with its elements');

  a.child.kill('SIGTERM');
  await waitFor(() => a.child.exitCode !== null, 8000, 'gateway exits on SIGTERM');
  assert((await json(`http://127.0.0.1:${canvasPort}/health`)).status === 200, 'the canvas outlives a gateway');
  await expectElements(b, 'split', 'after one gateway stopped');
  ok('stopping one gateway leaves the shared canvas and the other gateway serving');

  const bad = await startProcess({ PIZARRA_ROLE: 'canvas', CANVAS_URL: `http://127.0.0.1:${canvasPort}`, CANVAS_INTERNAL_PORT: String(await freePort()) }, null, 'bad');
  await waitFor(() => bad.child.exitCode !== null, 5000, 'contradictory role exits');
  assert(bad.child.exitCode !== 0 && /CANVAS_URL/.test(bad.output()), `PIZARRA_ROLE=canvas with CANVAS_URL is refused: ${bad.output()}`);
  ok('PIZARRA_ROLE=canvas together with CANVAS_URL is a startup error');
  for (const p of [b, canvas]) p.child.kill('SIGTERM');
  await waitFor(() => b.child.exitCode !== null && canvas.child.exitCode !== null, 8000, 'split processes exit');
}

async function checkOrphanProtection() {
  const gateway = await startGateway();
  gateway.child.kill('SIGKILL');
  await waitFor(() => !processAlive(gateway.upstreamPid), 5000, 'upstream exits after the gateway is SIGKILLed');
  ok('a SIGKILLed gateway leaves no upstream canvas behind');
}

try {
  console.log(`Proxy supervision checks (scratch: ${scratch})`);
  await checkEnvironmentAndRestart();
  await checkOrphanProtection();
  await checkDurability();
  await checkSplitCanvas();
  console.log(`Proxy supervision check passed: ${passed} groups.`);
} catch (error) {
  console.error(`Proxy supervision check failed after ${passed} groups: ${error.stack || error.message}`);
  console.error(`scratch kept: ${scratch}`);
  process.exitCode = 1;
} finally {
  killAll();
}
if (process.exitCode !== 1 && existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
process.exit(process.exitCode ?? 0);
