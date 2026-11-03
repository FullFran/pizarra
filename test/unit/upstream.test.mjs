// The upstream pin is recorded once (upstream.json) and everything else must
// agree with it; the stale-lock adapter follows upstream's lock format.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { clearStaleCanvasLock } from '../../dist/gateway/infrastructure/canvas-lock.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = path => JSON.parse(readFileSync(join(root, path), 'utf8'));

test('upstream is pinned to one commit, installed from the tarball built from it', () => {
  const pin = read('upstream.json');
  assert.match(pin.commit, /^[0-9a-f]{40}$/);
  const tarball = `file:vendor/mcp-excalidraw-server-${pin.commit.slice(0, 12)}.tgz`;
  assert.equal(read('package.json').dependencies['mcp-excalidraw-server'], tarball);
  const locked = read('package-lock.json').packages['node_modules/mcp-excalidraw-server'];
  assert.equal(locked.resolved, tarball);
  // Only upstream main (not the 2.1.2 npm release) has durable canvas state.
  assert.ok(existsSync(join(root, 'node_modules/mcp-excalidraw-server/dist/core/canvas-persistence.js')), 'installed upstream has durable state');
  const dockerfile = readFileSync(join(root, 'Dockerfile'), 'utf8');
  assert.ok(dockerfile.includes('upstream.json') && dockerfile.includes('build-upstream.sh'), 'the image builds upstream from the same pin');
});

function lockWith(pid, { token = randomUUID(), body } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pizarra-lock-'));
  const lockDir = join(dir, 'canvas-state.lock');
  mkdirSync(lockDir);
  writeFileSync(join(lockDir, `owner-${token}.json`), body ?? JSON.stringify({ pid, token }));
  return { dir, lockDir };
}

test('stale canvas lock: a dead owner is cleared, a live one is kept, anything odd is left to upstream', async () => {
  const dead = lockWith(2 ** 22 + 12345);
  assert.equal(clearStaleCanvasLock(dead.dir, () => false), 'cleared');
  assert.equal(existsSync(dead.lockDir), false);
  rmSync(dead.dir, { recursive: true });

  const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)']);
  try {
    const live = lockWith(sleeper.pid);
    assert.equal(clearStaleCanvasLock(live.dir), 'held');
    assert.equal(existsSync(live.lockDir), true);
    rmSync(live.dir, { recursive: true });
  } finally {
    sleeper.kill('SIGKILL');
  }

  const own = lockWith(process.pid);
  assert.equal(clearStaleCanvasLock(own.dir, () => true), 'cleared', 'a lock naming this very process is stale');
  rmSync(own.dir, { recursive: true });

  const mismatch = lockWith(1, { body: JSON.stringify({ pid: 1, token: 'other' }) });
  assert.equal(clearStaleCanvasLock(mismatch.dir, () => false), 'left');
  rmSync(mismatch.dir, { recursive: true });

  const empty = mkdtempSync(join(tmpdir(), 'pizarra-lock-'));
  assert.equal(clearStaleCanvasLock(empty), 'none');
  rmSync(empty, { recursive: true });
});
