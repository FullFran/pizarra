// Boards and memberships (docs/multiuser.md): who opens which board with
// which role, the 2026-11-05 defaults (admins create GitHub boards, an issuer
// creates its own on its first ticket, invites by GitHub login only), and the
// shared boards.json store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BoardService, JsonBoardStore, MemoryBoardStore, MAIN_BOARD, isBoardId } from '../../dist/boards/index.js';

const clock = { nowMs: () => 1_700_000_000_000 };
const admins = { has: login => login.toLowerCase() === 'fullfran' };
const github = (login, admin = admins.has(login)) => ({ kind: 'github', login, admin });
const issuer = (iss, role = 'editor') => ({ kind: 'issuer', issuer: iss, role });

function service(store = new MemoryBoardStore()) {
  return new BoardService(store, admins, clock);
}

test('board ids are lowercase slugs', () => {
  for (const ok of ['main', 'p-1', 'a', '0abc']) assert.ok(isBoardId(ok), ok);
  for (const bad of ['', 'Main', '-x', 'a/b', 'a.b', 'x'.repeat(64), '..', 'a b']) assert.ok(!isBoardId(bad), bad);
});

test('main exists from the first start; admins own every GitHub board, others need a membership', () => {
  const boards = service();
  boards.ensureMain();
  boards.ensureMain();
  assert.equal(boards.get(MAIN_BOARD).owner.kind, 'github');
  assert.equal(boards.roleFor(MAIN_BOARD, github('FullFran')), 'owner');
  assert.equal(boards.roleFor(MAIN_BOARD, github('stranger')), undefined);
  assert.equal(boards.roleFor(MAIN_BOARD, issuer('https://app.hagalink.es')), undefined, 'tickets never open a GitHub board');
  assert.equal(boards.maySignIn('stranger'), false);
  assert.equal(boards.maySignIn('FULLFRAN'), true);
});

test('only admins create GitHub boards', () => {
  const boards = service();
  assert.equal(boards.create(github('stranger'), 'b1', 'B1').error, 'forbidden');
  assert.equal(boards.create(issuer('x'), 'b1', 'B1').error, 'forbidden');
  const created = boards.create(github('FullFran'), 'b1', ' Board one ');
  assert.ok(created.ok);
  assert.equal(created.value.name, 'Board one');
  assert.deepEqual(created.value.owner, { kind: 'github', login: 'FullFran' });
  assert.equal(boards.create(github('FullFran'), 'b1', 'again').error, 'exists');
  assert.equal(boards.create(github('FullFran'), 'Bad', 'x').error, 'invalid');
  assert.equal(boards.create(github('FullFran'), 'b2', 'x\ny').error, 'invalid');
});

test('invites by GitHub login give editor or viewer; members may sign in; owners manage, members do not', () => {
  const boards = service();
  boards.create(github('FullFran'), 'b1', 'B1');
  assert.equal(boards.setMember(github('FullFran'), 'b1', 'Alice', 'editor').ok, true);
  assert.equal(boards.setMember(github('FullFran'), 'b1', 'bob', 'viewer').ok, true);
  assert.equal(boards.roleFor('b1', github('alice')), 'editor');
  assert.equal(boards.roleFor('b1', github('BOB')), 'viewer');
  assert.equal(boards.maySignIn('alice'), true);
  assert.equal(boards.setMember(github('alice'), 'b1', 'carol', 'editor').error, 'forbidden', 'an editor cannot invite');
  assert.equal(boards.setMember(github('carol'), 'b1', 'dave', 'editor').error, 'not_found', 'outsiders do not learn the board exists');
  assert.equal(boards.setMember(github('FullFran'), 'b1', 'not a login', 'editor').error, 'invalid');
  assert.equal(boards.setMember(github('FullFran'), 'b1', 'carol', 'owner').error, 'invalid');
  assert.deepEqual(boards.members(github('FullFran'), 'b1').value, { alice: 'editor', bob: 'viewer' });
  assert.equal(boards.removeMember(github('FullFran'), 'b1', 'alice').ok, true);
  assert.equal(boards.roleFor('b1', github('alice')), undefined);
  assert.equal(boards.maySignIn('alice'), false);
  assert.deepEqual(boards.visible(github('bob')).map(v => [v.board.id, v.role]), [['b1', 'viewer']]);
});

test('an issuer creates its own board on its first ticket; nobody else opens it, and it has no invites', () => {
  const boards = service();
  boards.ensureMain();
  boards.create(github('FullFran'), 'gh-board', 'GitHub board');
  assert.equal(boards.admitIssuer('https://x.example', 'p1'), true);
  assert.deepEqual(boards.get('p1').owner, { kind: 'issuer', issuer: 'https://x.example' });
  assert.equal(boards.admitIssuer('https://x.example', 'p1'), true);
  assert.equal(boards.admitIssuer('https://y.example', 'p1'), false, 'issuer Y never opens issuer X board');
  assert.equal(boards.admitIssuer('https://x.example', 'gh-board'), false, 'an issuer never takes a GitHub board');
  assert.equal(boards.admitIssuer('https://x.example', MAIN_BOARD), false);
  assert.equal(boards.admitIssuer('https://x.example', 'Bad/Id'), false);
  assert.equal(boards.roleFor('p1', issuer('https://x.example', 'viewer')), 'viewer');
  assert.equal(boards.roleFor('p1', issuer('https://y.example')), undefined);
  assert.equal(boards.roleFor('p1', github('FullFran')), undefined, 'admins do not open issuer boards');
  assert.equal(boards.setMember(github('FullFran'), 'p1', 'alice', 'editor').ok, false);
});

test('boards.json is shared between stores on the same file, mode 0600', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pizarra-boards-'));
  const path = join(dir, 'boards.json');
  const a = service(new JsonBoardStore(path));
  const b = service(new JsonBoardStore(path));
  a.ensureMain();
  a.create(github('FullFran'), 'b1', 'B1');
  b.setMember(github('FullFran'), 'b1', 'alice', 'editor');
  assert.equal(a.roleFor('b1', github('alice')), 'editor', 'a change on one store is seen by the other');
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const file = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(file.version, 1);
  assert.deepEqual(Object.keys(file.boards).sort(), ['b1', 'main']);
});
