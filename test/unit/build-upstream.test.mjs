// scripts/build-upstream.sh fetches the prebuilt upstream tarball published by the
// upstream-tarball workflow and checks it against the lockfile's integrity hash, so tests,
// Docker builds and local setups stop compiling Excalidraw from source (about 2 GB of RAM).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const commit = '66b768b47914987bb77a49e1fd1922e7f6deb0fe';
const tarball = Buffer.from('fake upstream tarball bytes');
const integrity = 'sha512-' + createHash('sha512').update(tarball).digest('base64');

function project(lockIntegrity) {
  const root = mkdtempSync(join(tmpdir(), 'pizarra-upstream-'));
  mkdirSync(join(root, 'scripts'));
  copyFileSync(join(repoRoot, 'scripts', 'build-upstream.sh'), join(root, 'scripts', 'build-upstream.sh'));
  // A repository that cannot be fetched: any attempt to build from source fails loudly.
  writeFileSync(join(root, 'upstream.json'), JSON.stringify({ repository: join(root, 'no-such-repo'), commit }));
  const entry = { resolved: `file:vendor/mcp-excalidraw-server-${commit.slice(0, 12)}.tgz` };
  if (lockIntegrity !== undefined) entry.integrity = lockIntegrity;
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/mcp-excalidraw-server': entry } }));
  return root;
}

async function serve(status, body) {
  const server = createServer((_req, res) => { res.statusCode = status; res.end(body); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}/asset.tgz` };
}

// Async on purpose: the fake release server lives in this process, so a blocking spawn would
// stop it from ever answering.
function run(root, env) {
  return new Promise((resolve) => {
    const child = spawn('sh', [join(root, 'scripts', 'build-upstream.sh')], { env: { ...process.env, ...env } });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.stdout.resume();
    child.on('close', (status) => resolve({ status, stderr }));
  });
}

const out = (root) => join(root, 'vendor', `mcp-excalidraw-server-${commit.slice(0, 12)}.tgz`);

test('downloads the published tarball and checks it against the lockfile integrity instead of compiling', async () => {
  const root = project(integrity);
  const { server, url } = await serve(200, tarball);
  try {
    const r = await run(root, { UPSTREAM_TARBALL_URL: url });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(readFileSync(out(root)), tarball);
  } finally { server.close(); rmSync(root, { recursive: true, force: true }); }
});

test('a tarball that does not match the lockfile integrity is refused and not kept', async () => {
  const root = project(integrity);
  const { server, url } = await serve(200, Buffer.from('tampered'));
  try {
    const r = await run(root, { UPSTREAM_TARBALL_URL: url });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /integrity mismatch/);
    assert.equal(existsSync(out(root)), false);
  } finally { server.close(); rmSync(root, { recursive: true, force: true }); }
});

test('a missing release fails with a hint instead of silently compiling', async () => {
  const root = project(integrity);
  const { server, url } = await serve(404, 'not found');
  try {
    const r = await run(root, { UPSTREAM_TARBALL_URL: url });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /BUILD_FROM_SOURCE=1/);
    assert.equal(existsSync(out(root)), false);
  } finally { server.close(); rmSync(root, { recursive: true, force: true }); }
});

test('without a lockfile integrity for the tarball it refuses to download', async () => {
  const root = project(undefined);
  try {
    const r = await run(root, { UPSTREAM_TARBALL_URL: 'http://127.0.0.1:9/never' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /integrity/);
    assert.equal(existsSync(out(root)), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
