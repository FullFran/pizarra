#!/usr/bin/env node
// Checks for signed board tickets from trusted issuers (docs/auth.md,
// issue #12) and for choosing auth providers by configuration: a fake
// issuer publishes an Ed25519 JWKS on loopback, another one is pinned with
// an ES256 key; a real `dist/main.js` gateway runs with
// AUTH_PROVIDERS=github,trusted-issuer next to a fake GitHub. Scratch state
// outside the repository, kept and printed on failure, removed on success.
import http from 'node:http';
import { createHmac, generateKeyPairSync, randomBytes, sign as signData } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assert, assertEqual, cookieHeader, freePort, githubEnv, githubLogin, killAll, mcpCall, mcpRawCall, mcpToolsList, request, setCookies, UTF8_BOM,
  startFakeGitHub, startGateway, waitFor
} from './lib/harness.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'pizarra-tickets-check-'));
let passed = 0;
function ok(label) { passed += 1; console.log(`  ok - ${label}`); }

const ISSUER_X = 'https://app.hagalink.example';
const ISSUER_Y = 'https://other-org.example';
const keyX = generateKeyPairSync('ed25519');
const keyXOther = generateKeyPairSync('ed25519');
const keyY = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const jwkX = { ...keyX.publicKey.export({ format: 'jwk' }), kid: 'x-1', use: 'sig', alg: 'EdDSA' };
const jwkY = { ...keyY.publicKey.export({ format: 'jwk' }), kid: 'y-1' };
const seenTickets = [];

const b64 = value => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');

/** A compact JWS; `alg` picks the signature (EdDSA, ES256, HS256 or none). */
function jws(payload, { alg = 'EdDSA', key = keyX.privateKey, kid = 'x-1', secret } = {}) {
  const header = { alg, typ: 'JWT', ...(kid ? { kid } : {}) };
  const data = `${b64(header)}.${b64(payload)}`;
  let signature = '';
  if (alg === 'EdDSA') signature = signData(null, Buffer.from(data), key).toString('base64url');
  if (alg === 'ES256') signature = signData('sha256', Buffer.from(data), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  if (alg === 'HS256') signature = createHmac('sha256', secret).update(data).digest('base64url');
  const token = `${data}.${signature}`;
  seenTickets.push(token);
  return token;
}

const now = () => Math.floor(Date.now() / 1000);
function claims(base, extra = {}) {
  return { iss: ISSUER_X, aud: base, sub: 'person-42', name: 'Ana Pérez', board: 'p1', role: 'editor', jti: randomBytes(12).toString('hex'), iat: now(), exp: now() + 120, ...extra };
}

async function startJwks() {
  const port = await freePort();
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ keys: [jwkX, { kty: 'RSA', n: 'x', e: 'AQAB', kid: 'ignored' }] }));
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${port}/.well-known/jwks.json`, close: () => new Promise(resolve => server.close(resolve)) };
}

function issuersEnv(jwksUrl) {
  return JSON.stringify([
    { issuer: ISSUER_X, alg: 'EdDSA', jwks_url: jwksUrl },
    { issuer: ISSUER_Y, alg: 'ES256', keys: [jwkY] }
  ]);
}

async function enter(base, board, ticket, headers = {}, query = '') {
  return request(base, { path: `/b/${board}/enter?ticket=${encodeURIComponent(ticket)}${query}`, headers });
}

async function checkStartupRules() {
  const refusal = async (env, mention, label, without = []) => {
    const gateway = await startGateway(scratch, env, { wait: false });
    await waitFor(() => gateway.child.exitCode !== null, 15000, `${label}: exits`);
    assert(gateway.child.exitCode !== 0, `${label}: refuses to start`);
    for (const text of mention) assert(gateway.output().includes(text), `${label}: names ${text}: ${gateway.output()}`);
    for (const text of without) assert(!gateway.output().includes(text), `${label}: does not ask for ${text}: ${gateway.output()}`);
  };
  const base = { AUTH_MODE: 'oauth', PUBLIC_BASE_URL: 'http://127.0.0.1:1', AUTH_SECRET: 'x'.repeat(48), EXCALIDRAW_DATA_DIR: join(scratch, 'refused') };
  await refusal({ ...base, AUTH_PROVIDERS: 'trusted-issuer' }, ['TRUSTED_ISSUERS'], 'trusted-issuer without TRUSTED_ISSUERS', ['GITHUB_CLIENT_ID', 'ALLOWED_GITHUB_LOGINS']);
  await refusal({ ...base, AUTH_PROVIDERS: 'trusted-issuer', TRUSTED_ISSUERS: JSON.stringify([{ issuer: ISSUER_X, alg: 'HS256', keys: [jwkX] }]) }, ['HS*'], 'an HS256 issuer');
  await refusal({ ...base, AUTH_PROVIDERS: 'trusted-issuer', TRUSTED_ISSUERS: JSON.stringify([{ issuer: ISSUER_X, alg: 'EdDSA', keys: [keyX.privateKey.export({ format: 'jwk' })] }]) }, ['public'], 'a private key pinned');
  await refusal({ ...base, AUTH_PROVIDERS: 'trusted-issuer', TRUSTED_ISSUERS: JSON.stringify([{ issuer: ISSUER_X, alg: 'EdDSA', jwks_url: 'http://jwks.internal/keys' }]) }, ['https'], 'a plain-http JWKS off loopback');
  await refusal({ ...base, AUTH_PROVIDERS: 'github,saml' }, ['unknown provider', 'saml'], 'an unknown provider');
  ok('AUTH_PROVIDERS picks the adapters; trusted-issuer needs TRUSTED_ISSUERS (not GitHub), never HS*, public keys only, https JWKS');
}

async function checkTickets() {
  const github = await startFakeGitHub();
  const jwks = await startJwks();
  const port = await freePort();
  const dataDir = join(scratch, 'tickets');
  const env = githubEnv(port, github.url, dataDir, { PORT: String(port), AUTH_PROVIDERS: 'github,trusted-issuer', TRUSTED_ISSUERS: issuersEnv(jwks.url), LOG_LEVEL: 'debug' });
  const gateway = await startGateway(scratch, env);
  const { base } = gateway;
  try {
    // --- browser: GET /b/<id>/enter?ticket=… ---
    const first = jws(claims(base));
    const entered = await enter(base, 'p1', first);
    assertEqual(entered.status, 303, `a valid ticket enters (${entered.text.slice(0, 200)})`);
    assertEqual(entered.headers.location, '/b/p1/', 'enter redirects to the board');
    assertEqual(entered.headers['referrer-policy'], 'no-referrer', 'the next page gets no Referer with the ticket');
    const jar = setCookies(entered);
    const cookieName = Object.keys(jar).find(name => name.endsWith('wb_b_p1'));
    assert(cookieName, `a board-scoped session cookie is set (${Object.keys(jar)})`);
    for (const attribute of ['HttpOnly', 'SameSite=Lax', 'Path=/']) assert(jar[cookieName].attributes.includes(attribute), `board cookie has ${attribute}`);
    const owner = JSON.parse(readFileSync(join(dataDir, 'boards.json'), 'utf8')).boards.p1.owner;
    assertEqual(JSON.stringify(owner), JSON.stringify({ kind: 'issuer', issuer: ISSUER_X }), 'the board is created for its issuer on the first ticket');
    const cookie = { cookie: cookieHeader({ [cookieName]: jar[cookieName] }), origin: base };
    assertEqual((await request(base, { path: '/b/p1/', headers: cookie })).status, 200, 'the cookie opens the board page');
    assertEqual((await request(base, { method: 'POST', path: '/b/p1/api/elements', headers: cookie, json: { id: 'from-ticket', type: 'rectangle', x: 0, y: 0, width: 5, height: 5 } })).status, 200, 'an editor ticket draws');
    assertEqual((await request(base, { path: '/b/p2/api/elements', headers: cookie })).status, 401, 'the board cookie does not open another board');
    assertEqual((await request(base, { path: '/api/elements', headers: cookie })).status, 401, 'nor board main');
    const embedded = await enter(base, 'p1', jws(claims(base)), {}, '&embed=1');
    assertEqual(embedded.headers.location, '/b/p1/?embed=1', 'embed=1 survives the entry');

    // --- rejections ---
    const reused = await enter(base, 'p1', first);
    assertEqual(reused.status, 401, 'a used ticket is rejected (browser)');
    assert(!reused.headers['set-cookie'], 'a rejected ticket sets no cookie');
    const rejected = [
      ['wrong signature', jws(claims(base), { key: keyXOther.privateKey }), 401],
      ['wrong aud', jws(claims(base, { aud: 'https://elsewhere.example' })), 401],
      ['expired', jws(claims(base, { iat: now() - 400, exp: now() - 10 })), 401],
      ['longer than five minutes', jws(claims(base, { iat: now(), exp: now() + 3600 })), 401],
      ['for another board', jws(claims(base, { board: 'p2' })), 403],
      ['HS256 (otherwise valid)', jws(claims(base), { alg: 'HS256', secret: 'shared-secret' }), 401],
      ['alg none', jws(claims(base), { alg: 'none' }), 401],
      ['ES256 from an EdDSA issuer', jws(claims(base), { alg: 'ES256', key: keyY.privateKey }), 401],
      ['unknown issuer', jws(claims(base, { iss: 'https://nobody.example' })), 401],
      ['bad role', jws(claims(base, { role: 'owner' })), 401],
      ['no jti', jws(claims(base, { jti: undefined })), 401]
    ];
    for (const [label, ticket, status] of rejected) {
      const response = await enter(base, 'p1', ticket);
      assertEqual(response.status, status, `${label} is rejected`);
      assert(!response.headers['set-cookie'], `${label} sets no cookie`);
      assertEqual(response.headers['x-frame-options'], 'DENY', `${label}: the error page cannot be framed`);
    }

    // --- one issuer never opens another's board, nor a GitHub board ---
    const admin = await githubLogin(base, github, 'FullFran');
    assert(admin.jar, 'GitHub sign-in still works next to the trusted issuer');
    const adminCookie = { cookie: cookieHeader(admin.jar), origin: base };
    assertEqual((await request(base, { method: 'POST', path: '/boards', headers: adminCookie, json: { id: 'ghb' } })).status, 201, 'an admin creates a GitHub board');
    assertEqual((await request(base, { path: '/b/ghb/api/elements', headers: adminCookie })).status, 200, 'the admin opens it');
    assertEqual((await request(base, { path: '/b/p1/api/elements', headers: adminCookie })).status, 404, 'a GitHub admin does not open an issuer board');
    const yForP1 = jws(claims(base, { iss: ISSUER_Y }), { alg: 'ES256', key: keyY.privateKey, kid: 'y-1' });
    assertEqual((await enter(base, 'p1', yForP1)).status, 403, 'issuer Y cannot enter issuer X board');
    assertEqual((await mcpToolsList(base, '/b/p1/mcp', { authorization: `Bearer ${jws(claims(base, { iss: ISSUER_Y }), { alg: 'ES256', key: keyY.privateKey, kid: 'y-1' })}` })).status, 401, 'issuer Y bearer is refused on issuer X board');
    assertEqual((await enter(base, 'ghb', jws(claims(base, { board: 'ghb' })))).status, 403, 'a ticket never opens a GitHub board');
    assertEqual((await enter(base, 'main', jws(claims(base, { board: 'main' })))).status, 403, 'nor board main');
    const yOwn = await enter(base, 'y1', jws(claims(base, { iss: ISSUER_Y, board: 'y1' }), { alg: 'ES256', key: keyY.privateKey, kid: 'y-1' }));
    assertEqual(yOwn.status, 303, 'issuer Y (pinned ES256 key) opens its own board');

    // --- agents: Authorization: Bearer <ticket> on /b/<id>/mcp, reusable until it expires ---
    const agentTicket = jws(claims(base));
    const bearer = { authorization: `Bearer ${agentTicket}` };
    assertEqual((await mcpToolsList(base, '/b/p1/mcp', bearer)).status, 200, 'a ticket opens its board\'s MCP');
    const created = await mcpCall(base, '/b/p1/mcp', 'create_element', { id: 'from-agent', type: 'ellipse', x: 1, y: 1, width: 9, height: 9 }, bearer);
    assert(created.result?.result && !created.result.result.isError, `an editor agent writes (${created.text.slice(0, 200)})`);
    assertEqual((await mcpToolsList(base, '/b/p1/mcp', bearer)).status, 200, 'the same ticket is reusable by an agent');
    assertEqual((await mcpToolsList(base, '/b/p2/mcp', bearer)).status, 401, 'an agent ticket does not open another board');
    assertEqual((await mcpToolsList(base, '/mcp', bearer)).status, 401, 'nor /mcp');
    assertEqual((await mcpToolsList(base, '/b/p1/mcp', { authorization: `Bearer ${jws(claims(base, { iat: now() - 400, exp: now() - 1 }))}` })).status, 401, 'an expired agent ticket is refused');
    assertEqual((await mcpToolsList(base, '/b/p1/mcp', { authorization: `Bearer ${jws(claims(base), { alg: 'HS256', secret: 's' })}` })).status, 401, 'an HS256 agent ticket is refused');
    const viewer = { authorization: `Bearer ${jws(claims(base, { role: 'viewer' }))}` };
    assertEqual((await mcpCall(base, '/b/p1/mcp', 'create_element', { id: 'by-viewer', type: 'rectangle', x: 0, y: 0, width: 1, height: 1 }, viewer)).status, 403, 'a viewer ticket cannot write over MCP');
    assert((await mcpCall(base, '/b/p1/mcp', 'query_elements', {}, viewer)).text.includes('from-agent'), 'a viewer ticket reads over MCP');
    // The viewer filter fails closed: a body it cannot read is refused, never passed on.
    const bomWrite = await mcpRawCall(base, '/b/p1/mcp', 'create_element', { id: 'by-viewer-bom', type: 'rectangle', x: 0, y: 0, width: 1, height: 1 }, viewer, { prefix: UTF8_BOM });
    assert(bomWrite.status === 403 || bomWrite.status === 400, `a viewer's BOM-prefixed create_element is refused (got ${bomWrite.status}: ${bomWrite.text.slice(0, 200)})`);
    for (const text of ['{"jsonrpc":"2.0","id":1,"method":"tools/call",', 'not json at all']) {
      const garbled = await mcpRawCall(base, '/b/p1/mcp', 'create_element', {}, viewer, { text });
      assert(garbled.status === 403 || garbled.status === 400, `a viewer's unparsable body is refused (got ${garbled.status})`);
    }
    const otherCharset = await mcpRawCall(base, '/b/p1/mcp', 'create_element', { id: 'by-viewer-latin1', type: 'rectangle', x: 0, y: 0, width: 1, height: 1 }, { ...viewer, 'content-type': 'application/json; charset=iso-8859-1' });
    assert(otherCharset.status === 403 || otherCharset.status === 400 || otherCharset.status === 415, `a viewer's body in another charset is refused (got ${otherCharset.status})`);
    for (const id of ['by-viewer-bom', 'by-viewer-latin1']) {
      assertEqual((await request(base, { path: `/b/p1/api/elements/${id}`, headers: bearer })).status, 404, `the refused viewer write ${id} did not happen`);
    }
    const editorBom = await mcpRawCall(base, '/b/p1/mcp', 'create_element', { id: 'by-editor-bom', type: 'rectangle', x: 0, y: 0, width: 1, height: 1 }, bearer, { prefix: UTF8_BOM });
    assertEqual(editorBom.status, 200, `an editor's BOM-prefixed create_element still works (${editorBom.text.slice(0, 200)})`);
    assertEqual((await request(base, { path: '/b/p1/api/elements/by-editor-bom', headers: bearer })).status, 200, 'the editor\'s BOM-prefixed write happened');
    const viewerEntry = await enter(base, 'p1', jws(claims(base, { role: 'viewer' })));
    const viewerJar = setCookies(viewerEntry);
    const viewerCookie = { cookie: cookieHeader({ [cookieName]: viewerJar[cookieName] }), origin: base };
    assertEqual((await request(base, { method: 'POST', path: '/b/p1/api/elements', headers: viewerCookie, json: { type: 'rectangle', x: 0, y: 0, width: 1, height: 1 } })).status, 403, 'a viewer ticket\'s browser cannot write');
    assertEqual((await request(base, { path: '/b/p1/api/elements/from-agent', headers: viewerCookie })).status, 200, 'a viewer ticket\'s browser reads');
    ok('browser tickets: single use, board-scoped cookie, board created for its issuer; wrong signature, aud, expiry, reuse, other board, HS256, none and foreign issuers rejected');
    ok('agent tickets on /b/<id>/mcp: reusable until they expire, one board only, viewer tickets read-only; issuers never cross boards (nor GitHub ones)');
  } finally {
    await gateway.stop();
    await jwks.close();
    await github.close();
  }
  const log = gateway.output();
  for (const ticket of seenTickets) {
    const signature = ticket.split('.')[2];
    assert(!log.includes(ticket) && !(signature && log.includes(signature)), `a ticket reached the log (debug level): ${ticket.slice(0, 40)}…`);
  }
  ok('tickets never reach the log, even at debug level');
}

try {
  console.log(`Ticket checks (scratch: ${scratch})`);
  await checkStartupRules();
  await checkTickets();
  console.log(`Ticket check passed: ${passed} groups.`);
} catch (error) {
  console.error(`Ticket check failed after ${passed} groups: ${error.stack || error.message}`);
  console.error(`scratch kept: ${scratch}`);
  process.exitCode = 1;
} finally {
  killAll();
}
if (process.exitCode !== 1 && existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
process.exit(process.exitCode ?? 0);
