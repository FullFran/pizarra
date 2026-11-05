// Shared helpers for the multi-user wire checks (boards, tickets, embedding):
// real `dist/main.js` gateways on random loopback ports, a fake GitHub
// (device flow), the OAuth flow driver, MCP and WebSocket clients. Every
// spawned process is killed when the script exits.
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const mainPath = join(repoRoot, 'dist', 'main.js');
const require = createRequire(import.meta.url);
export const WebSocket = require('ws');
export const MODERN_VERSION = '2026-07-28';
export const GH_CLIENT_ID = 'gh-test-client';

const spawned = new Set();
export function killAll() {
  for (const child of spawned) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}
process.on('exit', killAll);

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export function assert(condition, message) { if (!condition) throw new Error(message); }
export function assertEqual(actual, expected, message) {
  assert(actual === expected, `${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
  });
}

export async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(100);
  }
  throw new Error(`timed out: ${label}`);
}

/** Raw request so Origin/Cookie/Host can be set freely; the path is sent as given. */
export function request(base, { method = 'GET', path = '/', headers = {}, json, form } = {}) {
  const origin = new URL(base);
  let payload;
  const extra = {};
  if (json !== undefined) {
    payload = JSON.stringify(json);
    extra['content-type'] = 'application/json';
  } else if (form !== undefined) {
    payload = new URLSearchParams(form).toString();
    extra['content-type'] = 'application/x-www-form-urlencoded';
  }
  if (payload !== undefined) extra['content-length'] = Buffer.byteLength(payload);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: origin.hostname, port: origin.port, path, method, headers: { ...extra, ...headers } }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => {
        let body;
        try { body = JSON.parse(text); } catch { body = undefined; }
        resolve({ status: res.statusCode, headers: res.headers, text, body });
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error(`request timed out: ${method} ${path}`)));
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

export function setCookies(response) {
  const jar = {};
  for (const line of response.headers['set-cookie'] ?? []) {
    const [pair, ...attributes] = line.split(';');
    const index = pair.indexOf('=');
    jar[pair.slice(0, index).trim()] = { value: pair.slice(index + 1).trim(), attributes: attributes.map(a => a.trim()) };
  }
  return jar;
}

export function cookieHeader(jar) {
  return Object.entries(jar).filter(([, cookie]) => cookie.value !== '').map(([name, cookie]) => `${name}=${cookie.value}`).join('; ');
}

export function pkcePair() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

/** Spawns `dist/main.js`; waits until `/health` answers 200 unless `wait` is false. */
export async function startGateway(scratch, env = {}, { wait = true } = {}) {
  const port = env.PORT ? Number(env.PORT) : await freePort();
  const full = { ...process.env, PORT: String(port), HOST: '127.0.0.1', LOG_LEVEL: 'warn', XDG_STATE_HOME: scratch, ...env };
  for (const name of ['EXPRESS_SERVER_URL', 'TRUST_PROXY', 'AUTH_MODE', 'PUBLIC_BASE_URL', 'EXCALIDRAW_DATA_DIR', 'CANVAS_DATA_DIR', 'EXCALIDRAW_EXPORT_DIR',
    'CANVAS_URL', 'PIZARRA_ROLE', 'CANVAS_BIND_HOST', 'GITHUB_CLIENT_ID', 'ALLOWED_GITHUB_LOGINS', 'AUTH_SECRET', 'AUTH_PROVIDERS', 'TRUSTED_ISSUERS',
    'FRAME_ANCESTORS', 'BOARD_IDLE_SECONDS', 'MAX_OPEN_BOARDS', 'CANVAS_INTERNAL_PORT']) {
    if (!(name in env)) delete full[name];
  }
  const child = spawn(process.execPath, [mainPath], { cwd: scratch, env: full, stdio: ['ignore', 'pipe', 'pipe'] });
  spawned.add(child);
  child.once('exit', () => spawned.delete(child));
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const base = `http://127.0.0.1:${port}`;
  if (wait) {
    await waitFor(async () => {
      if (child.exitCode !== null) throw new Error(`gateway exited: ${output}`);
      try {
        return (await fetch(`${base}/health`, { signal: AbortSignal.timeout(500) })).status === 200;
      } catch {
        return false;
      }
    }, 20000, `gateway healthy (${output})`);
  }
  return {
    child, base, port, output: () => output,
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      await waitFor(() => child.exitCode !== null || child.signalCode !== null, 8000, 'gateway exits');
    }
  };
}

const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

/** Fake GitHub device flow; `approve(userCode, login)` plays the person on GitHub. */
export async function startFakeGitHub() {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const byUserCode = new Map();
  const byDeviceCode = new Map();
  const tokens = new Map();
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      const path = new URL(req.url, url).pathname;
      const params = new URLSearchParams(raw);
      const send = (body, status = 200) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); };
      if (req.method === 'POST' && path === '/login/device/code') {
        const deviceCode = randomBytes(20).toString('hex');
        const userCode = `${randomBytes(2).toString('hex')}-${randomBytes(2).toString('hex')}`.toUpperCase();
        const state = { login: null, used: false };
        byUserCode.set(userCode, state);
        byDeviceCode.set(deviceCode, state);
        return send({ device_code: deviceCode, user_code: userCode, verification_uri: `${url}/login/device`, expires_in: 900, interval: 1 });
      }
      if (req.method === 'POST' && path === '/login/oauth/access_token') {
        if (params.get('grant_type') !== DEVICE_GRANT) return send({ error: 'unsupported_grant_type' });
        const state = byDeviceCode.get(params.get('device_code') ?? '');
        if (!state || state.used) return send({ error: 'incorrect_device_code' });
        if (!state.login) return send({ error: 'authorization_pending' });
        state.used = true;
        const token = `gho_${randomBytes(18).toString('hex')}`;
        tokens.set(token, state.login);
        return send({ access_token: token, token_type: 'bearer', scope: 'read:user' });
      }
      if (req.method === 'GET' && path === '/user') {
        const login = tokens.get(/^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '');
        return login ? send({ login, id: 1 }) : send({ message: 'Bad credentials' }, 401);
      }
      send({ message: 'not found' }, 404);
    });
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return {
    url,
    approve: (userCode, login) => { byUserCode.get(userCode).login = login; },
    close: () => new Promise(resolve => server.close(resolve))
  };
}

export function githubEnv(port, githubUrl, dataDir, extra = {}) {
  return {
    AUTH_MODE: 'oauth',
    PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
    GITHUB_CLIENT_ID: GH_CLIENT_ID,
    GITHUB_OAUTH_BASE_URL: githubUrl,
    GITHUB_API_BASE_URL: githubUrl,
    ALLOWED_GITHUB_LOGINS: 'FullFran',
    AUTH_SECRET: 'check-secret-'.padEnd(48, 'x'),
    EXCALIDRAW_DATA_DIR: dataDir,
    TRUST_PROXY: 'loopback',
    ...extra
  };
}

let ipCounter = 0;
/** Full device login as `login`; returns the session jar (or the failed poll). */
export async function githubLogin(base, github, login, returnTo = '/') {
  const ip = `198.18.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;
  const headers = { 'x-forwarded-for': ip };
  const started = await request(base, { method: 'POST', path: '/oauth/login', headers: { ...headers, origin: base }, form: { return_to: returnTo } });
  assertEqual(started.status, 303, `device login start (${started.text.slice(0, 200)})`);
  const jar = setCookies(started);
  const page = await request(base, { path: '/oauth/device', headers: { ...headers, cookie: cookieHeader(jar) } });
  const userCode = /class="user-code">([A-Z0-9-]+)</.exec(page.text)?.[1];
  assert(userCode, `device page shows a code: ${page.text.slice(0, 300)}`);
  github.approve(userCode, login);
  await sleep(1100);
  const poll = await request(base, { method: 'POST', path: '/oauth/device/poll', headers: { ...headers, accept: 'application/json', origin: base, cookie: cookieHeader(jar) } });
  const merged = { ...jar, ...setCookies(poll) };
  const name = Object.keys(merged).find(key => key.endsWith('wb_session') && merged[key].value !== '');
  return { poll, jar: name ? { [name]: merged[name] } : null };
}

/** DCR client + authorize/consent/token for `resource` (undefined: the default `/mcp`). */
export async function obtainToken(base, jar, resource) {
  const redirectUri = 'http://127.0.0.1:43123/callback';
  const registration = await request(base, { method: 'POST', path: '/oauth/register', json: { client_name: 'Board check', redirect_uris: [redirectUri], token_endpoint_auth_method: 'none' } });
  assertEqual(registration.status, 201, `DCR (${registration.text})`);
  const clientId = registration.body.client_id;
  const { verifier, challenge } = pkcePair();
  const params = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirectUri, state: 's', code_challenge: challenge, code_challenge_method: 'S256' });
  if (resource) params.set('resource', resource);
  const page = await request(base, { path: `/oauth/authorize?${params}`, headers: { cookie: cookieHeader(jar) } });
  if (page.status !== 200) return { page };
  const ticket = /name="ticket" value="([^"]+)"/.exec(page.text)?.[1];
  const decided = await request(base, { method: 'POST', path: '/oauth/authorize', headers: { cookie: cookieHeader(jar), origin: base }, form: { ticket: ticket.replace(/&amp;/g, '&'), decision: 'approve' } });
  const code = new URL(decided.headers.location).searchParams.get('code');
  const exchange = await request(base, {
    method: 'POST', path: '/oauth/token',
    form: { grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier, ...(resource ? { resource } : {}) }
  });
  assertEqual(exchange.status, 200, `token exchange (${exchange.text})`);
  return { page, accessToken: exchange.body.access_token, refreshToken: exchange.body.refresh_token, clientId };
}

const ENVELOPE = {
  'io.modelcontextprotocol/protocolVersion': MODERN_VERSION,
  'io.modelcontextprotocol/clientCapabilities': {},
  'io.modelcontextprotocol/clientInfo': { name: 'board-check', version: '0.0.0' }
};

/** A tools/call over Streamable HTTP; returns { status, result, text }. */
export async function mcpCall(base, path, name, args, headers = {}) {
  const response = await request(base, {
    method: 'POST', path,
    headers: { accept: 'application/json, text/event-stream', 'mcp-protocol-version': MODERN_VERSION, 'mcp-method': 'tools/call', 'mcp-name': name, ...headers },
    json: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args, _meta: ENVELOPE } }
  });
  return { ...response, result: rpcResult(response) };
}

export async function mcpToolsList(base, path, headers = {}) {
  const response = await request(base, {
    method: 'POST', path,
    headers: { accept: 'application/json, text/event-stream', 'mcp-protocol-version': MODERN_VERSION, 'mcp-method': 'tools/list', ...headers },
    json: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: ENVELOPE } }
  });
  return { ...response, result: rpcResult(response) };
}

function rpcResult(response) {
  if (response.status !== 200) return undefined;
  const type = String(response.headers['content-type'] || '');
  try {
    const messages = type.includes('text/event-stream')
      ? response.text.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => JSON.parse(l.slice(5).trim()))
      : [JSON.parse(response.text)].flat();
    return messages.find(m => m.id === 1);
  } catch {
    return undefined;
  }
}

/** Opens a WebSocket and collects messages for `ms`; resolves { ok, status, messages, socket }. */
export function wsOpen(url, headers = {}, { keep = false } = {}) {
  return new Promise(resolve => {
    const socket = new WebSocket(url, { headers });
    const messages = [];
    const timer = setTimeout(() => { if (!keep) socket.terminate(); resolve({ ok: false, status: 'timeout', messages }); }, 5000);
    socket.on('message', data => {
      const message = JSON.parse(String(data));
      messages.push(message);
      if (message.type === 'initial_elements') {
        clearTimeout(timer);
        if (!keep) socket.close();
        resolve({ ok: true, messages, socket });
      }
    });
    socket.once('unexpected-response', (_req, res) => { clearTimeout(timer); resolve({ ok: false, status: res.statusCode, messages }); });
    socket.once('error', error => { clearTimeout(timer); resolve({ ok: false, status: error.message, messages }); });
  });
}

/** Resident set size of a process, in MiB (Linux). */
export function rssMiB(pid) {
  const status = readFileSync(`/proc/${pid}/status`, 'utf8');
  const kb = Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? 0);
  return Math.round(kb / 102.4) / 10;
}

/** Child pids of a process (Linux). */
export function childPids(pid) {
  try {
    return readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

/** Proportional set size of a process, in MiB (Linux): shared pages split between the processes using them. */
export function pssMiB(pid) {
  const rollup = readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8');
  const kb = Number(/^Pss:\s+(\d+)/m.exec(rollup)?.[1] ?? 0);
  return Math.round(kb / 102.4) / 10;
}
