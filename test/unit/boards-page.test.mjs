import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { BOARDS_SCRIPT, BOARDS_SCRIPT_PATH, boardsPageHtml } from '../../dist/gateway/presentation/http/boards-page.js';

class FakeNode {
  constructor(tag, id) {
    this.tagName = tag.toUpperCase();
    this.id = id;
    this.children = [];
    this.parent = null;
    this.own = '';
    this.listeners = {};
    this.hidden = false;
    this.value = '';
  }
  appendChild(child) { child.parent = this; this.children.push(child); return child; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this); this.parent = null; }
  set textContent(value) { this.children = []; this.own = String(value); }
  get textContent() { return this.own + this.children.map(c => c.textContent).join(''); }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  fire(type, event = {}) { for (const fn of this.listeners[type] || []) fn({ preventDefault() {}, ...event }); }
  all() { return [this, ...this.children.flatMap(c => c.all())]; }
}

const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setTimeout(resolve, 0)); };
const SHELL_IDS = ['boards', 'create', 'create-form', 'create-name', 'create-id', 'create-error'];

function page({ boards, members = {}, fail = {} }) {
  const ids = Object.fromEntries(SHELL_IDS.map(id => [id, new FakeNode(id === 'boards' ? 'ul' : 'div', id)]));
  ids.create.hidden = true;
  const calls = [];
  const assigned = [];
  const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });
  const fetch = async (path, init = {}) => {
    const method = init.method ?? 'GET';
    calls.push({ method, path, body: init.body && JSON.parse(init.body), accept: init.headers?.Accept });
    const key = `${method} ${path}`;
    if (fail[key]) return reply(fail[key].status, { success: false, error: fail[key].error });
    if (key === 'GET /boards') return reply(200, { boards });
    if (key === 'POST /boards') return reply(201, { board: JSON.parse(init.body) });
    const member = /^\/b\/([^/]+)\/members(?:\/(.+))?$/.exec(path);
    if (member) {
      const list = (members[member[1]] ||= {});
      if (method === 'PUT') list[decodeURIComponent(member[2])] = JSON.parse(init.body).role;
      if (method === 'DELETE') delete list[decodeURIComponent(member[2])];
      return reply(200, { members: Object.entries(list).map(([login, role]) => ({ login, role })) });
    }
    return reply(404, { error: 'nope' });
  };
  const document = {
    readyState: 'complete',
    getElementById: id => ids[id] ?? null,
    createElement: tag => new FakeNode(tag),
    addEventListener() {},
  };
  const window = { fetch, location: { assign: url => assigned.push(url) } };
  vm.runInContext(BOARDS_SCRIPT, vm.createContext({ window, document, encodeURIComponent, decodeURIComponent, JSON, String, Promise, Error, Object }));
  const nodes = () => Object.values(ids).flatMap(n => n.all());
  const find = (tag, text) => nodes().find(n => n.tagName === tag && n.textContent === text);
  return { ids, calls, assigned, nodes, find, members };
}

const MAIN_OWNER = { id: 'main', name: 'Main', role: 'owner', kind: 'github' };

test('the boards page shell loads its script and has every element the script needs', () => {
  const html = boardsPageHtml(true);
  assert.ok(html.includes(`<script src="${BOARDS_SCRIPT_PATH}" defer></script>`));
  for (const id of SHELL_IDS) assert.ok(html.includes(`id="${id}"`), id);
  assert.ok(html.includes('action="/oauth/logout"'));
  assert.equal(boardsPageHtml(false).includes('/oauth/logout'), false, 'no sign-out without sign-in');
  assert.equal(/<script>/.test(html), false, 'no inline script');
});

test('every board you can open is a link to it, with its role', async () => {
  const p = page({ boards: [MAIN_OWNER, { id: 'notes', name: 'Notes', role: 'viewer', kind: 'github' }] });
  await settle();
  assert.equal(p.calls[0].accept, 'application/json');
  const links = p.nodes().filter(n => n.tagName === 'A');
  assert.deepEqual(links.map(a => [a.textContent, a.href]), [['Main', '/b/main/'], ['Notes', '/b/notes/']]);
  assert.ok(p.ids.boards.textContent.includes('can view'));
});

test('an admin (owner of main) creates a board and lands on it; the id follows the name', async () => {
  const p = page({ boards: [MAIN_OWNER] });
  await settle();
  assert.equal(p.ids.create.hidden, false);
  p.ids['create-name'].value = 'Ideas de Clase';
  p.ids['create-name'].fire('input');
  assert.equal(p.ids['create-id'].value, 'ideas-de-clase');
  p.ids['create-form'].fire('submit');
  await settle();
  assert.deepEqual(p.calls.at(-1), { method: 'POST', path: '/boards', body: { id: 'ideas-de-clase', name: 'Ideas de Clase' }, accept: 'application/json' });
  assert.deepEqual(p.assigned, ['/b/ideas-de-clase/']);
});

test('a refused creation shows the server error and stays on the page', async () => {
  const p = page({ boards: [MAIN_OWNER], fail: { 'POST /boards': { status: 409, error: 'board alpha already exists' } } });
  await settle();
  p.ids['create-id'].value = 'alpha';
  p.ids['create-form'].fire('submit');
  await settle();
  assert.equal(p.ids['create-error'].hidden, false);
  assert.equal(p.ids['create-error'].textContent, 'board alpha already exists');
  assert.deepEqual(p.assigned, []);
});

test('a member who is not an admin sees no creation form and no member controls', async () => {
  const p = page({ boards: [{ id: 'main', name: 'Main', role: 'editor', kind: 'github' }] });
  await settle();
  assert.equal(p.ids.create.hidden, true);
  assert.equal(p.find('BUTTON', 'Members'), undefined);
});

test('an owner invites, changes the role of and removes members', async () => {
  const p = page({ boards: [MAIN_OWNER], members: { main: { ana: 'viewer' } } });
  await settle();
  p.find('BUTTON', 'Members').fire('click');
  await settle();
  assert.ok(p.ids.boards.textContent.includes('ana'));

  const invite = p.find('BUTTON', 'Invite').parent;
  const [login, role] = invite.children;
  login.value = '@bob';
  role.value = 'editor';
  invite.fire('submit');
  await settle();
  assert.deepEqual(p.calls.at(-1), { method: 'PUT', path: '/b/main/members/bob', body: { role: 'editor' }, accept: 'application/json' });
  assert.deepEqual(p.members.main, { ana: 'viewer', bob: 'editor' });
  assert.equal(login.value, '');

  const anaRow = p.nodes().find(n => n.tagName === 'LI' && n.children[0]?.textContent === 'ana');
  anaRow.children[1].value = 'editor';
  anaRow.children[1].fire('change');
  await settle();
  assert.equal(p.members.main.ana, 'editor');

  p.nodes().find(n => n.tagName === 'LI' && n.children[0]?.textContent === 'bob').children[2].fire('click');
  await settle();
  assert.deepEqual(p.calls.at(-1), { method: 'DELETE', path: '/b/main/members/bob', body: undefined, accept: 'application/json' });
  assert.deepEqual(p.members.main, { ana: 'editor' });
  assert.equal(p.ids.boards.textContent.includes('bob'), false);
});

test('issuer boards (opened by tickets) have no member controls', async () => {
  const p = page({ boards: [{ id: 'p1', name: 'P1', role: 'owner', kind: 'issuer' }] });
  await settle();
  assert.equal(p.find('BUTTON', 'Members'), undefined);
});
