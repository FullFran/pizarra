// The agent engine: draft extraction (pure), the throttle, and a protocol smoke test that
// spawns engine/main.mjs without network or login.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { baseToolName, createDraftThrottle, draftElements } from '../../engine/draft.mjs';
import { encode, parseChildMessage, LineDecoder } from '../../dist/agent/protocol.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const rect = (x) => ({ type: 'rectangle', x, y: 0, width: 10, height: 10 });

test('a streaming batch drops its last element, which may be cut off', () => {
  const out = draftElements('batch_create_elements', { elements: [rect(1), rect(2), { type: 'rectangle', x: 3 }] }, false);
  assert.deepEqual(out.map(e => e.x), [1, 2]);
  assert.deepEqual(draftElements('batch_create_elements', { elements: [rect(1)] }, false), []);
});

test('a complete batch keeps every element', () => {
  const out = draftElements('batch_create_elements', { elements: [rect(1), rect(2), rect(3)] }, true);
  assert.deepEqual(out.map(e => e.x), [1, 2, 3]);
});

test('create_element gives a shape only when complete', () => {
  assert.deepEqual(draftElements('create_element', rect(5), false), []);
  assert.deepEqual(draftElements('create_element', rect(5), true), [rect(5)]);
});

test('invalid shapes and arguments are dropped', () => {
  const out = draftElements('batch_create_elements', {
    elements: [rect(1), { type: 'image', x: 1, y: 1 }, null, 'x', { type: 'ellipse', x: 'a', y: 1 }, [], rect(2)],
  }, true);
  assert.deepEqual(out.map(e => e.x), [1, 2]);
  for (const args of [undefined, null, 'x', [], {}, { elements: 'x' }, { elements: {} }]) {
    assert.deepEqual(draftElements('batch_create_elements', args, true), []);
  }
  assert.deepEqual(draftElements('create_element', { type: 'rectangle' }, true), []);
});

test('only drawing properties survive in a draft', () => {
  const [e] = draftElements('create_element', { ...rect(1), id: 'abc', link: 'javascript:x', customData: { a: 1 } }, true);
  assert.deepEqual(e, rect(1));
});

test('tools that do not draw give nothing', () => {
  for (const tool of ['update_element', 'delete_element', 'query_elements', 'describe_scene', 'unknown']) {
    assert.deepEqual(draftElements(tool, { elements: [rect(1)], ...rect(1) }, true), []);
  }
});

test('the tool prefix is stripped from a tool name', () => {
  assert.equal(baseToolName('mcp__pizarra__batch_create_elements'), 'batch_create_elements');
  assert.equal(baseToolName('create_element'), 'create_element');
});

test('the throttle sends only changes, at most one per interval, and a final one', () => {
  let clock = 1000;
  const timers = [];
  const sent = [];
  const t = createDraftThrottle({
    send: m => sent.push(m), interval: 100, now: () => clock,
    schedule: (fn, ms) => { const id = { fn, ms }; timers.push(id); return id; },
    cancel: id => { timers.splice(timers.indexOf(id), 1); },
  });
  t.update(1, []);
  assert.equal(sent.length, 0, 'an empty list is not a change');
  t.update(1, [rect(1)]);
  assert.equal(sent.length, 1);
  clock += 30;
  t.update(1, [rect(1), rect(2)]);
  t.update(1, [rect(1), rect(2), rect(3)]);
  assert.equal(sent.length, 1, 'held inside the interval');
  assert.equal(timers.length, 1, 'one trailing timer');
  assert.equal(timers[0].ms, 70);
  clock += 70;
  timers.shift().fn();
  assert.equal(sent.length, 2);
  assert.equal(sent[1].elements.length, 3);
  t.update(1, [rect(1), rect(2), rect(3)]);
  t.final(1, [rect(1), rect(2), rect(3)]);
  assert.equal(sent.length, 2, 'an unchanged final is not sent again');
  t.update(2, [rect(9)]);
  assert.equal(sent.at(-1).call, 2, 'calls are throttled independently');
  clock += 1;
  t.update(2, [rect(9), rect(8)]);
  t.final(2, [rect(9), rect(8), rect(7)]);
  assert.equal(sent.at(-1).elements.length, 3, 'final goes out at once');
  assert.equal(timers.length, 0, 'final cancels the trailing timer');
  t.update(3, [rect(1)]);
  clock += 1;
  t.update(3, [rect(1), rect(2)]);
  t.clear();
  assert.equal(timers.length, 0);
});

const engine = join(root, 'engine/main.mjs');

test('the engine answers ready, ignores garbage, and exits when stdin closes', { skip: !existsSync(join(root, 'engine/node_modules')) && 'engine dependencies are not installed' }, async () => {
  const child = spawn(process.execPath, [engine], { stdio: ['pipe', 'pipe', 'ignore'], env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  const decoder = new LineDecoder();
  const messages = [];
  child.stdout.on('data', chunk => { for (const v of decoder.push(chunk)) messages.push(parseChildMessage(v)); });
  const exit = new Promise(resolveExit => child.on('exit', (code, signal) => resolveExit({ code, signal })));
  const deadline = Date.now() + 15_000;
  while (!messages.some(m => m?.type === 'ready') && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
  assert.ok(messages.some(m => m?.type === 'ready'), 'the engine says ready');
  child.stdin.write('not json\n');
  child.stdin.write(encode({ type: 'start', mcpUrl: 'https://example.com/mcp', mcpToken: 't', systemPrompt: 's' }));
  child.stdin.write(encode({ type: 'prompt', text: 'hi' }));
  child.stdin.write(encode({ type: 'reset' }));
  await new Promise(r => setTimeout(r, 300));
  assert.ok(!messages.some(m => m?.type === 'delta' || m?.type === 'draft'), 'nothing is drawn or said');
  assert.ok(messages.some(m => m?.type === 'error' && m.code === 'engine_unavailable'), 'a refused start leaves no session to prompt');
  assert.ok(messages.some(m => m?.type === 'reset.done'), 'reset is answered');
  child.stdin.end();
  let timer;
  const result = await Promise.race([exit, new Promise(r => { timer = setTimeout(() => r('timeout'), 10_000); })]);
  clearTimeout(timer);
  if (result === 'timeout') child.kill('SIGKILL');
  assert.notEqual(result, 'timeout', 'the engine exits when stdin closes');
  assert.equal(result.code, 0);
});
