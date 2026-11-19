import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { BOARD_SCRIPT, injectBoardScript } from '../../dist/gateway/presentation/http/board-page.js';
import { THINKING_LEVELS } from '../../dist/agent/protocol.js';
import { AGENT_SCRIPT, AGENT_SCRIPT_PATH } from '../../dist/agent/panel.js';

/** A style that behaves like the browser's: assigning cssText replaces every declaration. */
function fakeStyle() {
  const decl = new Map();
  const kebab = key => key.replace(/[A-Z]/g, m => '-' + m.toLowerCase());
  return new Proxy({}, {
    get(_, key) {
      if (key === 'cssText') return [...decl].map(([name, value]) => `${name}:${value}`).join(';');
      if (key === 'setProperty') return (name, value) => decl.set(name, String(value));
      if (key === 'getPropertyValue') return name => decl.get(name) ?? '';
      return typeof key === 'string' ? decl.get(kebab(key)) ?? '' : undefined;
    },
    set(_, key, value) {
      if (key === 'cssText') {
        decl.clear();
        for (const part of String(value).split(';')) {
          const at = part.indexOf(':');
          if (at > 0) decl.set(part.slice(0, at).trim(), part.slice(at + 1).trim());
        }
      } else if (value === '' || value == null) decl.delete(kebab(key));
      else decl.set(kebab(key), String(value));
      return true;
    },
  });
}

/** A tiny DOM: enough for the scripts, and it keeps everything they build inspectable. */
class FakeNode {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.attrs = {};
    this.style = fakeStyle();
    this.listeners = {};
    this.parent = null;
    this.own = '';
    this.value = '';
    this.dataset = {};
  }
  appendChild(child) { child.parent = this; this.children.push(child); return child; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this); this.parent = null; }
  set textContent(value) { this.children = []; this.own = String(value); }
  get textContent() { return this.own + this.children.map(c => c.textContent).join(''); }
  setAttribute(key, value) { this.attrs[key] = String(value); }
  getAttribute(key) { return this.attrs[key] ?? null; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  focus() {}
  all() { return [this, ...this.children.flatMap(c => c.all())]; }
  fire(type, event = {}) { for (const fn of this.listeners[type] || []) fn({ preventDefault() {}, ...event }); }
}

class FakeEventSource {
  static all = [];
  constructor(url) { this.url = url; this.listeners = {}; FakeEventSource.all.push(this); }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  close() {}
  emit(type, data) { for (const fn of this.listeners[type] || []) fn({ data: JSON.stringify(data) }); }
}

const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setTimeout(resolve, 0)); };
const sse = frames => frames.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');

function page({ search = '', status, login, prompt = [], withBoard = true, withAgent = true, models, storage = new Map() } = {}) {
  FakeEventSource.all = [];
  const calls = [];
  const timers = [];
  const delivered = [];
  const body = new FakeNode('body');
  let statusCalls = 0;
  const fetch = async (input, init = {}) => {
    const url = String(input);
    const method = init.method ?? 'GET';
    calls.push({ url, method, body: init.body });
    if (url.endsWith('/__agent/status')) {
      statusCalls += 1;
      const value = typeof status === 'function' ? status(statusCalls) : status;
      return { ok: true, status: 200, json: async () => value };
    }
    if (url.endsWith('/__agent/login')) return { ok: true, status: 200, json: async () => login };
    if (url.endsWith('/__agent/models') && models) return { ok: true, status: 200, json: async () => ({ models }) };
    if (url.endsWith('/__agent/prompt')) {
      const bytes = new TextEncoder().encode(sse(prompt));
      let sent = false;
      return {
        ok: true, status: 200, headers: { get: () => 'text/event-stream' },
        body: { getReader: () => ({ read: async () => (sent ? { done: true } : (sent = true, { done: false, value: bytes })) }) },
      };
    }
    if (url.endsWith('/__agent/abort') || url.endsWith('/__agent/reset') || url.endsWith('/__agent/logout')) return { ok: true, status: 204, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ success: true }) };
  };
  class FakeWebSocket {
    get onmessage() { return this._h || null; }
    set onmessage(fn) { this._h = fn; }
  }
  const window = {
    location: { href: `https://pizarra.test/b/main/${search}`, origin: 'https://pizarra.test', host: 'pizarra.test', search },
    fetch, WebSocket: FakeWebSocket, EventSource: FakeEventSource,
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)) },
  };
  const make = src => ({ dataset: { board: 'main' }, src });
  const document = {
    currentScript: null, body, addEventListener() {}, querySelector: () => null,
    createElement: tag => new FakeNode(tag),
  };
  const context = vm.createContext({
    window, document, URL, URLSearchParams, Request: class {}, TextDecoder, TextEncoder, Uint8Array,
    setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout() {}, console, JSON, Promise, Map, Set, Math, Number, String, Array, Object,
  });
  window.EventSource = FakeEventSource;
  if (withBoard) {
    document.currentScript = make('board');
    vm.runInContext(BOARD_SCRIPT, context);
    const socket = new window.WebSocket('wss://pizarra.test/');
    socket.onmessage = event => { delivered.push(JSON.parse(event.data)); };
  }
  if (withAgent) {
    document.currentScript = make('agent');
    vm.runInContext(AGENT_SCRIPT, context);
  }
  const nodes = () => body.all();
  const find = (tag, text) => nodes().find(n => n.tagName === tag && n.textContent.includes(text));
  return { window, body, calls, delivered, timers, nodes, find, storage, events: () => FakeEventSource.all[0], fetch: (...a) => window.fetch(...a) };
}

const drafts = p => p.delivered.filter(m => m.type === 'elements_batch_created');
const deleted = p => p.delivered.filter(m => m.type === 'element_deleted').map(m => m.elementId);

test('the agent script has a fixed path and the board script can add it to the page', () => {
  assert.equal(AGENT_SCRIPT_PATH, '/__pizarra/agent.js');
  const plain = injectBoardScript('<html><head></head></html>', { id: 'main', name: 'Main', signOut: false });
  assert.ok(!plain.includes('agent.js'));
  const withAgent = injectBoardScript('<html><head></head></html>', { id: 'main', name: 'Main', signOut: false }, { agent: true });
  assert.ok(withAgent.includes('<script src="/__pizarra/agent.js" data-board="main" defer></script>'));
  assert.ok(withAgent.indexOf('board.js') < withAgent.indexOf('agent.js'));
});

test('a draft event delivers provisional elements with draft ids, also in embed mode', async () => {
  const p = page({ search: '?embed=1', status: { enabled: true, connected: true, busy: false, pending: null } });
  const es = p.events();
  assert.equal(es.url, '/b/main/__agent/events');
  es.emit('draft', { id: 'c1', elements: [{ type: 'rectangle', x: 1, y: 2, width: 30, height: 20, text: 'hi' }, { type: 'arrow', x: 5, y: 5, width: 10, height: 0 }] });
  await settle();
  const batch = drafts(p)[0];
  assert.ok(batch, 'a batch is delivered');
  assert.ok(batch.elements.length >= 2);
  for (const element of batch.elements) {
    assert.match(element.id, /^pizarra-draft-c1-/);
    assert.ok(element.opacity <= 50);
  }
  assert.ok(batch.elements.some(e => e.id === 'pizarra-draft-c1-0' && e.type === 'rectangle'));
  assert.ok(batch.elements.some(e => e.id === 'pizarra-draft-c1-1' && e.type === 'arrow'));
  assert.equal(p.nodes().some(n => n.attrs['data-pizarra-panel'] !== undefined), false, 'no panel in embed mode');
});

test('a later draft with fewer elements deletes the missing ones; draft.end deletes the rest', async () => {
  const p = page({ status: { enabled: false } });
  const es = p.events();
  const shape = (x) => ({ type: 'ellipse', x, y: 0, width: 5, height: 5 });
  es.emit('draft', { id: 'c2', elements: [shape(0), shape(10), shape(20)] });
  es.emit('draft', { id: 'c2', elements: [shape(0)] });
  assert.deepEqual(deleted(p).sort(), ['pizarra-draft-c2-1', 'pizarra-draft-c2-2']);
  es.emit('draft.end', { id: 'c2' });
  assert.deepEqual(deleted(p).sort(), ['pizarra-draft-c2-0', 'pizarra-draft-c2-1', 'pizarra-draft-c2-2']);
  es.emit('draft.end', { id: 'c2' });
  assert.equal(deleted(p).length, 3, 'ending an unknown draft deletes nothing more');
});

test('without the board hook the drafts do nothing', async () => {
  const p = page({ withBoard: false, status: { enabled: false } });
  p.events().emit('draft', { id: 'c3', elements: [{ type: 'rectangle', x: 0, y: 0 }] });
  assert.equal(p.delivered.length, 0);
});

test('an agent event shows who is drawing, as text, and hides it when idle', async () => {
  const p = page({ status: { enabled: false } });
  p.events().emit('agent', { state: 'working', login: '<b>ana</b>' });
  const badge = () => p.nodes().find(n => n.attrs['data-pizarra-drawing'] !== undefined);
  assert.ok(badge().textContent.includes('<b>ana</b> is drawing'));
  assert.match(badge().style.cssText, /display:block/);
  p.events().emit('agent', { state: 'idle', login: 'ana' });
  assert.match(badge().style.cssText, /display:none/);
});

test('the sync of this page never carries draft elements', async () => {
  const p = page({ status: { enabled: false } });
  await p.fetch('/api/elements/sync', {
    method: 'POST',
    body: JSON.stringify({ elements: [{ id: 'a', type: 'rectangle' }, { id: 'pizarra-draft-c1-0', type: 'rectangle' }], timestamp: 'x' }),
  });
  const sent = p.calls.find(c => c.url.endsWith('/api/elements/sync'));
  const parsed = JSON.parse(sent.body);
  assert.deepEqual(parsed.elements.map(e => e.id), ['a']);
  assert.equal(parsed.timestamp, 'x');
  assert.ok(!sent.body.includes('pizarra-draft-'));
});

test('status enabled:false shows no panel', async () => {
  const p = page({ status: { enabled: false, connected: false, busy: false, pending: null } });
  await settle();
  assert.ok(p.calls.some(c => c.url === '/b/main/__agent/status'));
  assert.equal(p.nodes().some(n => n.attrs['data-pizarra-panel'] !== undefined), false);
});

test('embed mode does not even ask for the status', async () => {
  const p = page({ search: '?embed=1', status: { enabled: true, connected: true, busy: false, pending: null } });
  await settle();
  assert.equal(p.calls.some(c => c.url.endsWith('/__agent/status')), false);
});

const connected = { enabled: true, connected: true, busy: false, pending: null };

test('narration with markup ends up as text and creates no element', async () => {
  const hostile = 'hi <img src=x onerror=alert(1)> <script>alert(2)</script>';
  const p = page({
    status: connected,
    prompt: [['delta', { text: hostile }], ['thinking', { text: '<b>hmm</b>' }], ['tool', { call: 1, name: 'create_element', phase: 'start', ok: true }], ['done', { aborted: false }]],
  });
  await settle();
  const input = p.nodes().find(n => n.tagName === 'TEXTAREA');
  assert.ok(input, 'a prompt box is shown');
  input.value = 'draw a box';
  input.fire('keydown', { key: 'Enter', shiftKey: false });
  await settle();
  const post = p.calls.find(c => c.url.endsWith('/__agent/prompt'));
  assert.deepEqual(JSON.parse(post.body), { text: 'draw a box' });
  assert.equal(p.nodes().some(n => ['IMG', 'SCRIPT'].includes(n.tagName)), false);
  assert.ok(p.body.textContent.includes(hostile));
  assert.ok(p.body.textContent.includes('<b>hmm</b>'));
  assert.ok(p.body.textContent.includes('drawing'));
});

test('Shift+Enter does not send', async () => {
  const p = page({ status: connected });
  await settle();
  const input = p.nodes().find(n => n.tagName === 'TEXTAREA');
  input.value = 'x';
  input.fire('keydown', { key: 'Enter', shiftKey: true });
  await settle();
  assert.equal(p.calls.some(c => c.url.endsWith('/__agent/prompt')), false);
});

test('the verification link is rendered only for the fixed address', async () => {
  const run = async uri => {
    const p = page({
      status: n => (n === 1 ? { enabled: true, connected: false, busy: false, pending: null } : { enabled: true, connected: false, busy: false, pending: { userCode: 'ABCD-1234', verificationUri: uri } }),
      login: { userCode: 'ABCD-1234', verificationUri: uri },
    });
    await settle();
    p.find('BUTTON', 'Connect').fire('click');
    await settle();
    return p;
  };
  const good = await run('https://auth.openai.com/codex/device');
  const link = good.nodes().find(n => n.tagName === 'A' && n.attrs.target === '_blank');
  assert.ok(link);
  assert.equal(link.attrs.href, 'https://auth.openai.com/codex/device');
  assert.equal(link.attrs.rel, 'noopener noreferrer');
  assert.equal(link.attrs.target, '_blank');
  assert.ok(good.body.textContent.includes('ABCD-1234'));
  const bad = await run('https://auth.openai.com.evil.test/codex/device');
  assert.equal(bad.nodes().some(n => n.tagName === 'A' && n.attrs.href !== undefined), false);
  assert.ok(bad.body.textContent.includes('ABCD-1234'));
});

test('the Agent button opens the panel and a theme repaint keeps it open', async () => {
  const p = page({ status: connected });
  await settle();
  const toggle = p.find('BUTTON', 'Agent');
  const panel = toggle.parent.children[0];
  assert.equal(panel.style.display, 'none');
  toggle.fire('click');
  assert.equal(toggle.attrs['aria-expanded'], 'true');
  assert.equal(panel.style.display, 'flex', 'the panel is visible after a click');
  toggle.fire('click');
  assert.equal(panel.style.display, 'none', 'a second click closes it');
});

const MODELS = [
  { id: 'gpt-a', name: 'GPT A', levels: ['off', 'low', 'medium', 'high'] },
  { id: 'gpt-b', name: 'GPT B <b>', levels: ['off'] },
];
const selects = p => {
  const [model, thinking] = p.nodes().filter(n => n.tagName === 'SELECT');
  return { model, thinking };
};

test('the panel offers the account\'s models and their thinking levels, and remembers the choice', async () => {
  const storage = new Map([['pizarra.agent.choice', JSON.stringify({ model: 'gpt-a', thinking: 'high' })]]);
  const p = page({ status: connected, models: MODELS, storage, prompt: [['settings', { model: 'gpt-a', thinking: 'medium' }], ['done', { aborted: false }]] });
  await settle();
  assert.ok(p.calls.some(c => c.url.endsWith('/__agent/models') && c.method === 'POST'), 'the list is asked for once connected');
  const { model, thinking } = selects(p);
  assert.deepEqual(model.children.map(o => [o.value, o.textContent]), [['gpt-a', 'GPT A'], ['gpt-b', 'GPT B <b>']], 'names are text');
  assert.deepEqual(thinking.children.map(o => o.value), ['off', 'low', 'medium', 'high']);
  assert.equal(model.value, 'gpt-a');
  assert.equal(thinking.value, 'high', 'the saved choice comes back');

  // A model without reasoning offers only "off"; the choice is saved.
  model.value = 'gpt-b';
  model.fire('change');
  assert.deepEqual(thinking.children.map(o => o.value), ['off']);
  assert.equal(thinking.value, 'off');
  assert.equal(thinking.disabled, true);
  assert.deepEqual(JSON.parse(p.storage.get('pizarra.agent.choice')), { model: 'gpt-b', thinking: 'off' });

  // Back to a reasoning model: the level is clamped like pi does (off stays off).
  model.value = 'gpt-a';
  model.fire('change');
  thinking.value = 'low';
  thinking.fire('change');
  assert.deepEqual(JSON.parse(p.storage.get('pizarra.agent.choice')), { model: 'gpt-a', thinking: 'low' });

  // Each turn carries the choice; the engine's effective settings are shown.
  const input = p.nodes().find(n => n.tagName === 'TEXTAREA');
  input.value = 'draw';
  input.fire('keydown', { key: 'Enter', shiftKey: false });
  await settle();
  const post = p.calls.find(c => c.url.endsWith('/__agent/prompt'));
  assert.deepEqual(JSON.parse(post.body), { text: 'draw', model: 'gpt-a', thinking: 'low' });
  assert.equal(thinking.value, 'medium', 'the settings event shows the level the turn really used');
  assert.deepEqual(JSON.parse(p.storage.get('pizarra.agent.choice')), { model: 'gpt-a', thinking: 'low' }, 'and does not overwrite the saved choice');
});

test('a saved level the model lacks is clamped up, then down', async () => {
  const p = page({ status: connected, models: [{ id: 'gpt-a', name: 'A', levels: ['off', 'low', 'medium'] }], storage: new Map([['pizarra.agent.choice', JSON.stringify({ model: 'gone', thinking: 'xhigh' })]]) });
  await settle();
  const { model, thinking } = selects(p);
  assert.equal(model.value, 'gpt-a', 'an unknown saved model falls back to the first');
  assert.equal(thinking.value, 'medium');
});

test('a list with no valid model leaves the selectors hidden', async () => {
  const p = page({ status: connected, models: [{ id: 'bad id!', name: 'x', levels: ['off'] }] });
  await settle();
  const row = selects(p).model.parent;
  assert.equal(row.style.display, 'none');
});

test('the panel knows the same thinking levels as the protocol', () => {
  const levels = /const LEVELS = (\[[^\]]*\]);/.exec(AGENT_SCRIPT)[1];
  assert.deepEqual(JSON.parse(levels.replace(/'/g, '"')), [...THINKING_LEVELS]);
});
