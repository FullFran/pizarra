#!/usr/bin/env node
// Checks for the gateway's supervision of the upstream canvas: it runs on an
// internal loopback port with an environment stripped of the gateway's
// settings, is restarted after a crash (/health says 503 meanwhile), stops
// with the gateway (SIGTERM), and exits by itself when the gateway is killed
// (SIGKILL), so no canvas process is ever left behind. Real `dist/main.js`
// processes; scratch state outside the repository, removed on success.

import { spawn } from 'node:child_process';
import net from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
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
  if (!extraEnv.AUTH_MODE) for (const name of ['AUTH_MODE', 'PUBLIC_BASE_URL', 'EXCALIDRAW_DATA_DIR']) delete env[name];
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
  return { child, base, internalPort, upstreamPid: upstream.body.pid, output: () => output };
}

async function checkEnvironmentAndRestart() {
  const secret = randomBytes(36).toString('base64');
  const port = await freePort();
  const gateway = await startGateway({
    AUTH_MODE: 'oauth', PUBLIC_BASE_URL: 'http://127.0.0.1:1', GITHUB_CLIENT_ID: 'gh-proxy-check', ALLOWED_GITHUB_LOGINS: 'FullFran',
    AUTH_SECRET: secret, EXCALIDRAW_DATA_DIR: join(scratch, `data-${port}`)
  });
  const environ = readFileSync(`/proc/${gateway.upstreamPid}/environ`, 'utf8');
  for (const name of ['AUTH_SECRET', 'GITHUB_CLIENT_ID', 'ALLOWED_GITHUB_LOGINS', 'PUBLIC_BASE_URL', 'EXCALIDRAW_DATA_DIR', 'AUTH_MODE']) {
    assert(!environ.includes(`${name}=`), `upstream environment must not carry ${name}`);
  }
  assert(!environ.includes(secret), 'the signing secret never reaches the upstream');
  assert(environ.split('\0').includes('HOST=127.0.0.1'), 'upstream binds 127.0.0.1');
  ok('upstream canvas runs on 127.0.0.1 with none of the gateway\'s auth settings in its environment');

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
