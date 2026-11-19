/**
 * The boards page: what a browser gets at `GET /boards` (the JSON stays for
 * every other client). It lists the boards the visitor can open, lets admins
 * create one and lets owners of a GitHub board manage its members, all through
 * the JSON API (`/boards`, `/b/<id>/members`). Static shell plus a same-origin
 * script, so the page CSP allows no inline script.
 */

export const BOARDS_SCRIPT_PATH = '/__pizarra/boards.js';

export const BOARDS_PAGE_CSP =
  "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

const STYLE = `
  :root { color-scheme: light dark; --bg: #f7f7f8; --fg: #1d1d1f; --card: #fff; --muted: #5f6368; --accent: #6965db; --border: #d9d9de; --danger: #d93025; }
  @media (prefers-color-scheme: dark) { :root { --bg: #121214; --fg: #ececf1; --card: #1e1e22; --muted: #a0a0aa; --accent: #a8a5ff; --border: #34343a; --danger: #f28b82; } }
  body { margin: 0; font: 15px/1.5 system-ui, sans-serif; background: var(--bg); color: var(--fg); }
  main { max-width: 40rem; margin: 6vh auto; padding: 0 16px; display: flex; flex-direction: column; gap: 16px; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 20px 24px; }
  header { display: flex; justify-content: space-between; align-items: center; }
  h1 { font-size: 1.3rem; margin: 0; } h2 { font-size: 1.05rem; margin: 0 0 12px; }
  ul { list-style: none; margin: 0; padding: 0; }
  li.board { padding: 10px 0; border-top: 1px solid var(--border); } li.board:first-child { border-top: 0; }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .grow { flex: 1; }
  .board-name { font-weight: 600; font-size: 1.02rem; }
  .meta, .note { color: var(--muted); font-size: .85rem; }
  .members { margin: 10px 0 0; padding: 12px; border: 1px dashed var(--border); border-radius: 8px; display: flex; flex-direction: column; gap: 8px; }
  input, select { font: inherit; padding: 6px 8px; border-radius: 6px; border: 1px solid var(--border); background: transparent; color: var(--fg); }
  button { font: inherit; padding: 6px 12px; border-radius: 8px; border: 1px solid var(--border); background: transparent; color: var(--fg); cursor: pointer; }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  button.link { border: 0; padding: 0; color: var(--accent); }
  button.danger { color: var(--danger); }
  a { color: var(--accent); text-decoration: none; } a:hover { text-decoration: underline; }
  .error { color: var(--danger); font-size: .9rem; }
  form { margin: 0; }
`;

/** The HTML shell; `signOut` adds the sign-out button (only when sign-in exists). */
export function boardsPageHtml(signOut: boolean): string {
  const signOutForm = signOut
    ? '<form method="post" action="/oauth/logout"><button type="submit" class="link">Sign out</button></form>'
    : '';
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<title>Boards · pizarra</title><style>${STYLE}</style><script src="${BOARDS_SCRIPT_PATH}" defer></script></head><body><main>` +
    `<header><h1>Boards</h1>${signOutForm}</header>` +
    '<section class="card"><ul id="boards"><li class="note">Loading…</li></ul></section>' +
    '<section class="card" id="create" hidden><h2>New board</h2>' +
    '<form id="create-form" class="row"><input id="create-name" class="grow" placeholder="Name" maxlength="100" required>' +
    '<input id="create-id" placeholder="id (a-z, 0-9, -)" pattern="[a-z0-9][a-z0-9\\-]{0,62}" maxlength="63" required>' +
    '<button type="submit" class="primary">Create</button></form>' +
    '<p class="note">The id is part of the board\'s address: /b/&lt;id&gt;/. It cannot change later.</p>' +
    '<p class="error" id="create-error" hidden></p></section>' +
    '</main></body></html>';
}

export const BOARDS_SCRIPT = String.raw`(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const api = async (method, path, body) => {
    const init = { method, credentials: 'same-origin', headers: { Accept: 'application/json' } };
    if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
    const response = await window.fetch(path, init);
    let data = null;
    try { data = await response.json(); } catch { data = null; }
    if (!response.ok) throw new Error((data && data.error) || 'Request failed (' + response.status + ')');
    return data;
  };
  const ROLE = { owner: 'owner', editor: 'can edit', viewer: 'can view' };
  const slug = name => String(name).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63);

  const membersPanel = board => {
    const box = el('div', 'members');
    const list = el('ul');
    const error = el('p', 'error');
    error.hidden = true;
    const fail = err => { error.textContent = err.message; error.hidden = false; };
    const render = data => {
      error.hidden = true;
      list.textContent = '';
      const members = (data && data.members) || [];
      if (members.length === 0) list.appendChild(el('li', 'note', 'No members yet. Invite someone by their GitHub login.'));
      for (const member of members) {
        const row = el('li', 'row');
        row.appendChild(el('span', 'grow', member.login));
        const role = el('select');
        for (const value of ['editor', 'viewer']) {
          const option = el('option', '', ROLE[value]);
          option.value = value;
          role.appendChild(option);
        }
        role.value = member.role;
        role.addEventListener('change', () => {
          api('PUT', '/b/' + board.id + '/members/' + encodeURIComponent(member.login), { role: role.value }).then(render, fail);
        });
        const remove = el('button', 'danger', 'Remove');
        remove.type = 'button';
        remove.addEventListener('click', () => {
          api('DELETE', '/b/' + board.id + '/members/' + encodeURIComponent(member.login)).then(render, fail);
        });
        row.appendChild(role);
        row.appendChild(remove);
        list.appendChild(row);
      }
    };
    const form = el('form', 'row');
    const login = el('input', 'grow');
    login.placeholder = 'GitHub login';
    login.required = true;
    const role = el('select');
    for (const value of ['editor', 'viewer']) {
      const option = el('option', '', ROLE[value]);
      option.value = value;
      role.appendChild(option);
    }
    const invite = el('button', 'primary', 'Invite');
    invite.type = 'submit';
    form.appendChild(login);
    form.appendChild(role);
    form.appendChild(invite);
    form.addEventListener('submit', event => {
      event.preventDefault();
      const name = String(login.value).trim().replace(/^@/, '');
      if (!name) return;
      api('PUT', '/b/' + board.id + '/members/' + encodeURIComponent(name), { role: role.value })
        .then(data => { login.value = ''; render(data); }, fail);
    });
    box.appendChild(list);
    box.appendChild(form);
    box.appendChild(el('p', 'note', 'Members sign in with GitHub and see only the boards they are invited to.'));
    box.appendChild(error);
    api('GET', '/b/' + board.id + '/members').then(render, fail);
    return box;
  };

  const boardItem = board => {
    const item = el('li', 'board');
    const row = el('div', 'row');
    const link = el('a', 'board-name grow', board.name || board.id);
    link.href = '/b/' + board.id + '/';
    row.appendChild(link);
    row.appendChild(el('span', 'meta', '/b/' + board.id + '/ · ' + (ROLE[board.role] || board.role)));
    item.appendChild(row);
    if (board.role === 'owner' && board.kind === 'github') {
      const toggle = el('button', 'link', 'Members');
      toggle.type = 'button';
      let panel = null;
      toggle.addEventListener('click', () => {
        if (panel) { panel.remove(); panel = null; return; }
        panel = membersPanel(board);
        item.appendChild(panel);
      });
      row.appendChild(toggle);
    }
    return item;
  };

  const setupCreate = () => {
    $('create').hidden = false;
    const name = $('create-name');
    const id = $('create-id');
    const error = $('create-error');
    let edited = false;
    id.addEventListener('input', () => { edited = true; });
    name.addEventListener('input', () => { if (!edited) id.value = slug(name.value); });
    $('create-form').addEventListener('submit', event => {
      event.preventDefault();
      error.hidden = true;
      const board = String(id.value).trim();
      api('POST', '/boards', { id: board, name: String(name.value).trim() || board })
        .then(() => { window.location.assign('/b/' + board + '/'); }, err => { error.textContent = err.message; error.hidden = false; });
    });
  };

  const load = async () => {
    const list = $('boards');
    try {
      const data = await api('GET', '/boards');
      const boards = (data && data.boards) || [];
      list.textContent = '';
      if (boards.length === 0) list.appendChild(el('li', 'note', 'No boards yet.'));
      for (const board of boards) list.appendChild(boardItem(board));
      // Only admins create boards, and the admins are exactly the owners of board main.
      if (boards.some(board => board.id === 'main' && board.role === 'owner' && board.kind === 'github')) setupCreate();
    } catch (err) {
      list.textContent = '';
      list.appendChild(el('li', 'error', err.message));
    }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { void load(); });
  else void load();
})();
`;
