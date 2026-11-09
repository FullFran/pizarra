import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { BOARD_SCRIPT } from '../../dist/gateway/presentation/http/board-page.js';

/**
 * Runs the board script in a fake page: a WebSocket whose `onmessage` is an accessor (as in
 * browsers), a fetch that answers the canvas API, and the page's own handler recording what it
 * receives. Upstream broadcasts `elements_synced` (a count, no elements) when someone's browser
 * syncs, so without the script other people never see a person's strokes until they reload.
 */
function page({ serverElements }) {
  const calls = [];
  const sockets = [];
  let server = serverElements;
  class FakeWebSocket {
    constructor(url) { this.url = url; this._handler = null; sockets.push(this); }
    get onmessage() { return this._handler; }
    set onmessage(fn) { this._handler = fn; }
    emit(message) { this._handler?.call(this, { data: JSON.stringify(message) }); }
  }
  const fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, method: init.method ?? 'GET', body: init.body });
    if (url.endsWith('/api/elements') && (init.method ?? 'GET') === 'GET') {
      return { ok: true, json: async () => ({ success: true, elements: server }) };
    }
    return { ok: true, json: async () => ({ success: true }) };
  };
  const window = {
    location: { href: 'https://pizarra.test/b/main/?embed=1', origin: 'https://pizarra.test', host: 'pizarra.test', search: '?embed=1' },
    fetch,
    WebSocket: FakeWebSocket,
  };
  const document = { currentScript: { dataset: { board: 'main' } }, body: null, addEventListener() {} };
  const context = vm.createContext({ window, document, URL, URLSearchParams, Request: class {}, setTimeout, console, JSON, Promise, Map, Set });
  vm.runInContext(BOARD_SCRIPT, context);
  const received = [];
  const socket = new window.WebSocket('wss://pizarra.test/');
  socket.onmessage = event => { received.push(JSON.parse(event.data)); };
  return {
    socket: sockets[0],
    received,
    calls,
    setServer(next) { server = next; },
    fetch: (...args) => window.fetch(...args),
  };
}

const el = (id, nonce, extra = {}) => ({ id, type: 'rectangle', versionNonce: nonce, version: 1, ...extra });
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

test('another person\'s sync reaches this page: changed elements merged, removed ones deleted', async () => {
  const p = page({ serverElements: [] });
  p.socket.emit({ type: 'initial_elements', elements: [el('a', 1), el('b', 1), el('c', 1)] });
  p.setServer([el('a', 1), el('b', 2, { syncedAt: 'x' }), el('d', 1)]);
  p.socket.emit({ type: 'elements_synced', count: 3 });
  await settle(); await settle();
  const types = p.received.map(m => m.type);
  assert.deepEqual(types, ['initial_elements', 'elements_synced', 'elements_batch_created', 'element_deleted']);
  assert.deepEqual(p.received[2].elements.map(e => e.id), ['b', 'd']);
  assert.equal(p.received[3].elementId, 'c');
  assert.ok(p.calls.some(c => c.url === 'https://pizarra.test/b/main/api/elements'));
});

test('the echo of this page\'s own sync is not fetched again', async () => {
  const p = page({ serverElements: [] });
  p.socket.emit({ type: 'initial_elements', elements: [] });
  await p.fetch('/api/elements/sync', { method: 'POST', body: JSON.stringify({ elements: [el('a', 1)] }) });
  p.socket.emit({ type: 'elements_synced', count: 1 });
  await settle(); await settle();
  assert.equal(p.calls.filter(c => c.method === 'GET').length, 0);
  assert.deepEqual(p.received.map(m => m.type), ['initial_elements', 'elements_synced']);
});

test('a sync that changed nothing this page lacks sends nothing', async () => {
  const p = page({ serverElements: [el('a', 1)] });
  p.socket.emit({ type: 'initial_elements', elements: [el('a', 1)] });
  p.socket.emit({ type: 'elements_synced', count: 1 });
  await settle(); await settle();
  assert.deepEqual(p.received.map(m => m.type), ['initial_elements', 'elements_synced']);
});
