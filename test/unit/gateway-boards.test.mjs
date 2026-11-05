// Gateway rules for boards: one path parser for the gateway and the pool,
// the viewer's read-only MCP tools, and the viewer's WebSocket filter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { parseBoardPath } from '../../dist/gateway/domain/board-path.js';
import { toolsRefusedToViewer } from '../../dist/gateway/domain/viewer-policy.js';
import { dropDataFrames } from '../../dist/gateway/infrastructure/websocket-filter.js';

test('board paths: /b/<id>/... is that board, anything else is main, other cases of /b/ are refused', () => {
  assert.deepEqual(parseBoardPath('/b/alpha/api/elements'), { kind: 'board', board: 'alpha', rest: '/api/elements', prefixed: true, bare: false });
  assert.deepEqual(parseBoardPath('/b/alpha/'), { kind: 'board', board: 'alpha', rest: '/', prefixed: true, bare: false });
  assert.deepEqual(parseBoardPath('/b/alpha'), { kind: 'board', board: 'alpha', rest: '/', prefixed: true, bare: true });
  assert.deepEqual(parseBoardPath('/api/elements'), { kind: 'board', board: 'main', rest: '/api/elements', prefixed: false, bare: false });
  assert.deepEqual(parseBoardPath('/'), { kind: 'board', board: 'main', rest: '/', prefixed: false, bare: false });
  for (const bad of ['/B/alpha/api', '/b/Alpha/', '/b/', '/b', '/b//api', '/b/-x/', '/b/a.b/']) assert.equal(parseBoardPath(bad).kind, 'invalid', bad);
  assert.equal(parseBoardPath('/boards').board, 'main', '/boards is not a board path');
});

test('viewer MCP: only read-only tools, in single messages and batches', () => {
  const call = name => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name } });
  assert.deepEqual(toolsRefusedToViewer(call('query_elements')), []);
  assert.deepEqual(toolsRefusedToViewer(call('get_canvas_screenshot')), []);
  assert.deepEqual(toolsRefusedToViewer({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), []);
  assert.deepEqual(toolsRefusedToViewer(call('create_element')), ['create_element']);
  assert.deepEqual(toolsRefusedToViewer([call('get_element'), call('clear_canvas'), call('export_to_image')]), ['clear_canvas', 'export_to_image']);
  assert.deepEqual(toolsRefusedToViewer({ jsonrpc: '2.0', method: 'tools/call', params: {} }), ['(unnamed)']);
  assert.deepEqual(toolsRefusedToViewer({ method: 'tools/call', params: { name: 'some_future_tool' } }), ['some_future_tool'], 'an unknown tool is refused');
});

function frame(opcode, payload, { fin = true, length } = {}) {
  const data = Buffer.from(payload);
  const mask = Buffer.from([1, 2, 3, 4]);
  const masked = Buffer.from(data.map((byte, i) => byte ^ mask[i % 4]));
  const size = length ?? data.length;
  const header = size < 126 ? Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | size])
    : Buffer.concat([Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | 126]), Buffer.from([size >> 8, size & 255])]);
  return Buffer.concat([header, mask, masked]);
}

test('viewer WebSocket: control frames pass, text/binary/continuation frames are dropped, even split across chunks', async () => {
  const client = new PassThrough();
  const upstream = new PassThrough();
  const forwarded = [];
  upstream.on('data', chunk => forwarded.push(chunk));
  dropDataFrames(client, upstream);
  const ping = frame(0x9, 'hi');
  const close = frame(0x8, '');
  const stream = Buffer.concat([frame(0x1, '{"type":"x"}', { fin: false }), frame(0x0, 'more'), ping, frame(0x2, 'x'.repeat(300)), close]);
  for (let i = 0; i < stream.length; i += 7) client.write(stream.subarray(i, i + 7));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(Buffer.concat(forwarded), Buffer.concat([ping, close]));
});

test('viewer WebSocket: unmasked or reserved-opcode frames close both sides', async () => {
  for (const bad of [Buffer.from([0x81, 0x02, 0x68, 0x69]), frame(0x3, 'x')]) {
    const client = new PassThrough();
    const upstream = new PassThrough();
    dropDataFrames(client, upstream);
    client.write(bad);
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(client.destroyed && upstream.destroyed);
  }
});

test('framing: board pages for the listed origins only; upstream CSP directives are kept', async () => {
  const { framingHeaders, parseFrameAncestors } = await import('../../dist/gateway/domain/framing.js');
  assert.deepEqual(parseFrameAncestors(' https://a.example, https://b.example:8443 https://a.example '), ['https://a.example', 'https://b.example:8443']);
  assert.deepEqual(parseFrameAncestors(undefined), []);
  for (const bad of ['*', 'https://*.example', 'http://a.example', 'https://a.example/x', "'self'"]) assert.throws(() => parseFrameAncestors(bad), /FRAME_ANCESTORS/, bad);
  assert.deepEqual(framingHeaders('board', ['https://a.example'], undefined), { csp: 'frame-ancestors https://a.example' });
  assert.deepEqual(framingHeaders('board', [], undefined), { csp: "frame-ancestors 'none'", xFrameOptions: 'DENY' });
  assert.deepEqual(framingHeaders('other', ['https://a.example'], "default-src 'self'; frame-ancestors *"), { csp: "default-src 'self'; frame-ancestors 'none'", xFrameOptions: 'DENY' });
});

test('viewer MCP requests fail closed: BOM decoded like the handler, unreadable bodies refused', async () => {
  const { viewerRequestVerdict } = await import('../../dist/gateway/domain/viewer-policy.js');
  const body = (value, prefix = []) => Buffer.concat([Buffer.from(prefix), Buffer.from(typeof value === 'string' ? value : JSON.stringify(value))]);
  const call = name => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name } });
  const bom = [0xef, 0xbb, 0xbf];
  assert.equal(viewerRequestVerdict(body(call('create_element'), bom), {}).status, 403, 'a BOM does not hide a write');
  assert.equal(viewerRequestVerdict(body(call('query_elements'), bom), {}).ok, true, 'a BOM-prefixed read is read');
  assert.equal(viewerRequestVerdict(body([call('get_element'), call('clear_canvas')], bom), {}).status, 403, 'batches too');
  for (const bad of ['{"jsonrpc":', 'nope', '[]', '[1]', 'null']) assert.equal(viewerRequestVerdict(body(bad), {}).status, 400, bad);
  assert.equal(viewerRequestVerdict(Buffer.from([0xff, 0xfe, 0x7b, 0x00]), {}).status, 400, 'not UTF-8');
  assert.equal(viewerRequestVerdict(body(call('query_elements')), { contentEncoding: 'gzip' }).status, 415);
  assert.equal(viewerRequestVerdict(body(call('query_elements')), { contentType: 'application/json; charset=utf-16' }).status, 415);
  assert.equal(viewerRequestVerdict(body(call('query_elements')), { contentType: 'application/json; charset=UTF-8' }).ok, true);
  assert.equal(viewerRequestVerdict(body(call('query_elements')), { mcpMethod: 'tools/call', mcpName: 'create_element' }).status, 403, 'the mcp-name header is checked too');
  assert.equal(viewerRequestVerdict(undefined, {}).ok, true, 'no body (GET, DELETE) calls no tool');
});
