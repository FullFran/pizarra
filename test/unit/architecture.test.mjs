// Dependency rule of the hexagon: domain imports nothing outside its
// domain (and no Node/Express), application only its domain and ports, and
// the auth and gateway contexts never import each other (main.ts wires them).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = resolve(dirname(fileURLToPath(import.meta.url)), '../../src');

function files(dir) {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : path.endsWith('.ts') ? [path] : [];
  });
}

function imports(file) {
  return [...readFileSync(file, 'utf8').matchAll(/(?:import|export)[^'"]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)]
    .map(match => match[1] ?? match[2]);
}

function target(file, specifier) {
  return specifier.startsWith('.') ? relative(src, resolve(dirname(file), specifier)) : specifier;
}

for (const context of ['auth', 'gateway']) {
  test(`${context}: domain is pure`, () => {
    for (const file of files(join(src, context, 'domain'))) {
      for (const spec of imports(file)) {
        const to = target(file, spec);
        assert.ok(to.startsWith(`${context}/domain/`), `${relative(src, file)} imports ${spec}`);
      }
    }
  });

  test(`${context}: application depends only on its domain, its ports and shared`, () => {
    for (const file of files(join(src, context, 'application'))) {
      for (const spec of imports(file)) {
        const to = target(file, spec);
        assert.ok(to.startsWith(`${context}/domain/`) || to.startsWith(`${context}/application/`) || to.startsWith('shared/'),
          `${relative(src, file)} imports ${spec}`);
      }
    }
  });
}

test('auth and gateway never import each other', () => {
  for (const [from, forbidden] of [['auth', 'gateway/'], ['gateway', 'auth/']]) {
    for (const file of files(join(src, from))) {
      for (const spec of imports(file)) {
        assert.ok(!target(file, spec).startsWith(forbidden), `${relative(src, file)} imports ${spec}`);
      }
    }
  }
});

test('only gateway infrastructure knows the upstream package', () => {
  for (const file of files(src)) {
    const rel = relative(src, file);
    for (const spec of imports(file)) {
      if (spec.startsWith('mcp-excalidraw-server')) assert.ok(rel.startsWith('gateway/infrastructure/'), `${rel} imports ${spec}`);
    }
  }
});
