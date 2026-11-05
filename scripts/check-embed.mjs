#!/usr/bin/env node
// Checks for embeddable boards (docs/auth.md "Embedding boards", issue #13):
// FRAME_ANCESTORS lets the listed origins frame board pages
// (Content-Security-Policy frame-ancestors, no X-Frame-Options); without it
// every page refuses framing; sign-in and consent pages always refuse it.
// Real `dist/main.js` gateways and a fake GitHub; scratch outside the repository.
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assert, assertEqual, cookieHeader, freePort, githubEnv, githubLogin, killAll, obtainToken, request, startFakeGitHub, startGateway, waitFor
} from './lib/harness.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'pizarra-embed-check-'));
let passed = 0;
function ok(label) { passed += 1; console.log(`  ok - ${label}`); }
const EMBEDDER = 'https://app.hagalink.example';

function refusesFraming(response, label) {
  assertEqual(response.headers['x-frame-options'], 'DENY', `${label}: X-Frame-Options`);
  assert(/frame-ancestors 'none'/.test(response.headers['content-security-policy'] ?? ''), `${label}: frame-ancestors 'none' (${response.headers['content-security-policy']})`);
}

async function withGateway(extra, run) {
  const github = await startFakeGitHub();
  const port = await freePort();
  const gateway = await startGateway(scratch, githubEnv(port, github.url, join(scratch, `data-${port}`), { PORT: String(port), ...extra }));
  try {
    const admin = await githubLogin(gateway.base, github, 'FullFran');
    await run(gateway, { cookie: cookieHeader(admin.jar) }, admin.jar);
  } finally {
    await gateway.stop();
    await github.close();
  }
}

async function pages(base, cookie, jar) {
  const board = await request(base, { path: '/b/main/', headers: cookie });
  assertEqual(board.status, 200, 'board page');
  const legacy = await request(base, { path: '/', headers: cookie });
  const api = await request(base, { path: '/b/main/api/elements', headers: cookie });
  const asset = await request(base, { path: /src="(\/assets\/[^"]+\.js)"/.exec(board.text)[1], headers: cookie });
  const login = await request(base, { path: '/oauth/login' });
  const consent = (await obtainToken(base, jar)).page;
  assertEqual(consent.status, 200, 'consent page');
  const enterError = await request(base, { path: '/b/p1/enter?ticket=nope' });
  return { board, legacy, api, asset, login, consent, enterError };
}

async function checkNoFrameAncestors() {
  await withGateway({}, async ({ base }, cookie, jar) => {
    const all = await pages(base, cookie, jar);
    for (const [label, response] of Object.entries(all)) {
      if (label === 'enterError') continue; // trusted-issuer is off: a 404 JSON
      refusesFraming(response, `${label} without FRAME_ANCESTORS`);
    }
  });
  ok('with FRAME_ANCESTORS empty, every page refuses framing (board pages, main at /, API, assets, sign-in, consent)');
}

async function checkFrameAncestors() {
  await withGateway({ FRAME_ANCESTORS: `${EMBEDDER} https://other.hagalink.example` }, async ({ base }, cookie, jar) => {
    const all = await pages(base, cookie, jar);
    for (const label of ['board', 'legacy']) {
      const response = all[label];
      assertEqual(response.headers['x-frame-options'], undefined, `${label}: no X-Frame-Options on a board page`);
      assertEqual(response.headers['content-security-policy'], `frame-ancestors ${EMBEDDER} https://other.hagalink.example`, `${label}: listed origins may frame it`);
      assert(!response.headers['content-security-policy'].includes('evil'), `${label}: an unlisted origin is not allowed`);
    }
    for (const label of ['login', 'consent', 'asset']) refusesFraming(all[label], `${label} with FRAME_ANCESTORS`);
    const embedded = await request(base, { path: '/b/main/?embed=1', headers: cookie });
    assertEqual(embedded.headers['content-security-policy'], `frame-ancestors ${EMBEDDER} https://other.hagalink.example`, 'the embedded view may be framed');
    const script = await request(base, { path: '/__pizarra/board.js' });
    assert(/get\('embed'\) === '1'/.test(script.text) && script.text.includes('data-pizarra-chrome'), 'embed=1 hides pizarra\'s chrome (board name, sign out)');
  });
  ok('a listed origin can frame board pages (CSP frame-ancestors, no X-Frame-Options); sign-in and consent pages still refuse, even from a listed origin');
}

async function checkBadValue() {
  for (const bad of ['*', 'app.hagalink.es', 'http://app.hagalink.example', 'https://app.hagalink.example/path']) {
    const gateway = await startGateway(scratch, { FRAME_ANCESTORS: bad }, { wait: false });
    await waitFor(() => gateway.child.exitCode !== null, 15000, `FRAME_ANCESTORS=${bad} exits`);
    assert(gateway.child.exitCode !== 0 && gateway.output().includes('FRAME_ANCESTORS'), `FRAME_ANCESTORS=${bad} refuses to start: ${gateway.output()}`);
  }
  ok('FRAME_ANCESTORS accepts only exact https origins (no wildcard, path or plain http)');
}

try {
  console.log(`Embedding checks (scratch: ${scratch})`);
  await checkNoFrameAncestors();
  await checkFrameAncestors();
  await checkBadValue();
  console.log(`Embedding check passed: ${passed} groups.`);
} catch (error) {
  console.error(`Embedding check failed after ${passed} groups: ${error.stack || error.message}`);
  console.error(`scratch kept: ${scratch}`);
  process.exitCode = 1;
} finally {
  killAll();
}
if (process.exitCode !== 1 && existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
process.exit(process.exitCode ?? 0);
