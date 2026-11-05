// The canvas image copies only the compiled files the canvas role imports
// (so gateway-only commits leave it byte-identical): every module
// dist/canvas-main.js reaches must be in one of its COPY lines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const dist = join(root, 'dist');

function reach(file, seen = new Set()) {
  if (seen.has(file)) return seen;
  seen.add(file);
  const source = readFileSync(file, 'utf8');
  for (const match of source.matchAll(/(?:import|export)[^'"]*?from\s+['"](\.[^'"]+)['"]|import\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
    reach(resolve(dirname(file), match[1] ?? match[2]), seen);
  }
  return seen;
}

test('the canvas image copies every module the canvas role imports', () => {
  const dockerfile = readFileSync(join(root, 'Dockerfile'), 'utf8');
  const stage = dockerfile.slice(dockerfile.indexOf('FROM base AS canvas'), dockerfile.indexOf('FROM base AS runtime'));
  const sources = [...stage.matchAll(/^COPY [^\n]*--from=build ([^\n]+) \S+$/gm)].flatMap(m => m[1].split(/\s+/)).map(p => p.replace(/^\/app\//, ''));
  for (const file of reach(join(dist, 'canvas-main.js'))) {
    const rel = relative(root, file);
    assert.ok(sources.some(source => rel === source || rel.startsWith(`${source}/`)), `${rel} is not copied into the canvas image`);
  }
});
