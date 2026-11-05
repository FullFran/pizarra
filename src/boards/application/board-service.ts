import { MAIN_BOARD, isBoardId, isGitHubLogin, isMemberRole, mayManageMembers, roleOn } from '../domain/board.js';
import type { Board, MemberRole, Role, Visitor } from '../domain/board.js';
import type { Admins, BoardStore, Clock } from './ports.js';

export type BoardError = 'not_found' | 'forbidden' | 'invalid' | 'exists';
export type BoardResult<T = Board> = { ok: true; value: T } | { ok: false; error: BoardError; message: string };

const NAME_MAX = 100;

function fail<T>(error: BoardError, message: string): BoardResult<T> {
  return { ok: false, error, message };
}

function cleanName(name: unknown, fallback: string): string | undefined {
  if (name === undefined) return fallback;
  if (typeof name !== 'string') return undefined;
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > NAME_MAX || /[\u0000-\u001f\u007f]/.test(trimmed)) return undefined;
  return trimmed;
}

function own<T>(map: Record<string, T>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

/**
 * Boards and who may open them. Decisions (taken by the board's rules in
 * the domain) always read the shared store, so a membership added on one
 * gateway counts on every other at once.
 *
 * Defaults (docs/multiuser.md, 2026-11-05): only admins create GitHub
 * boards; a trusted issuer creates its own board on its first valid ticket;
 * GitHub boards invite by login (editor or viewer); issuer boards have no
 * invites.
 */
export class BoardService {
  constructor(private readonly store: BoardStore, private readonly admins: Admins, private readonly clock: Clock) {}

  private now(): number {
    return Math.floor(this.clock.nowMs() / 1000);
  }

  visitorForLogin(login: string): Visitor {
    return { kind: 'github', login, admin: this.admins.has(login) };
  }

  get(id: string): Board | undefined {
    return isBoardId(id) ? this.store.get(id) : undefined;
  }

  exists(id: string): boolean {
    return this.get(id) !== undefined;
  }

  roleFor(id: string, visitor: Visitor): Role | undefined {
    const board = this.get(id);
    return board ? roleOn(board, visitor) : undefined;
  }

  /** The boards `visitor` can open, with their role. */
  visible(visitor: Visitor): Array<{ board: Board; role: Role }> {
    const result: Array<{ board: Board; role: Role }> = [];
    for (const board of this.store.list()) {
      const role = roleOn(board, visitor);
      if (role) result.push({ board, role });
    }
    return result.sort((a, b) => a.board.id.localeCompare(b.board.id));
  }

  /** Whether a GitHub login may sign in at all: an admin, or a member of some board. */
  maySignIn(login: string): boolean {
    if (this.admins.has(login)) return true;
    const key = login.toLowerCase();
    return this.store.list().some(board => board.owner.kind === 'github' && own(board.members, key) !== undefined);
  }

  /** Board `main` (today's canvas) exists from the first start, run by the admins. */
  ensureMain(): void {
    if (this.store.get(MAIN_BOARD)) return;
    this.store.update(boards => {
      if (!own(boards, MAIN_BOARD)) {
        boards[MAIN_BOARD] = { id: MAIN_BOARD, name: 'Main', owner: { kind: 'github' }, members: {}, createdAt: this.now() };
      }
    });
  }

  /** A GitHub board; only admins may create one. */
  create(actor: Visitor | undefined, id: unknown, name: unknown): BoardResult {
    if (actor && (actor.kind !== 'github' || !actor.admin)) return fail('forbidden', 'only admins create boards');
    if (!isBoardId(id)) return fail('invalid', 'board id must be 1-63 lowercase letters, digits or dashes');
    const clean = cleanName(name, id);
    if (!clean) return fail('invalid', `board name must be 1-${NAME_MAX} printable characters`);
    return this.store.update<BoardResult>(boards => {
      if (own(boards, id)) return fail('exists', 'a board with this id already exists');
      const board: Board = {
        id, name: clean, members: {}, createdAt: this.now(),
        owner: actor?.kind === 'github' ? { kind: 'github', login: actor.login } : { kind: 'github' }
      };
      boards[id] = board;
      return { ok: true, value: board };
    });
  }

  /**
   * A valid ticket from `issuer` for `id`: the board is created for that
   * issuer if it does not exist; it opens only if that issuer owns it.
   */
  admitIssuer(issuer: string, id: string): boolean {
    if (!isBoardId(id)) return false;
    const existing = this.store.get(id);
    if (existing) return existing.owner.kind === 'issuer' && existing.owner.issuer === issuer;
    return this.store.update(boards => {
      const current = own(boards, id);
      if (current) return current.owner.kind === 'issuer' && current.owner.issuer === issuer;
      boards[id] = { id, name: id, owner: { kind: 'issuer', issuer }, members: {}, createdAt: this.now() };
      return true;
    });
  }

  private managed(actor: Visitor | undefined, id: string): BoardResult {
    const board = this.get(id);
    // Not found and not allowed look the same to whoever cannot open the board.
    if (!board) return fail('not_found', 'board not found');
    if (actor === undefined) {
      return board.owner.kind === 'github' ? { ok: true, value: board } : fail('forbidden', 'the issuer decides who opens this board');
    }
    const role = roleOn(board, actor);
    if (!role) return fail('not_found', 'board not found');
    if (!mayManageMembers(board, role)) {
      return fail('forbidden', board.owner.kind === 'issuer' ? 'the issuer decides who opens this board' : 'only the board owner manages members');
    }
    return { ok: true, value: board };
  }

  members(actor: Visitor | undefined, id: string): BoardResult<Record<string, MemberRole>> {
    const board = this.managed(actor, id);
    return board.ok ? { ok: true, value: { ...board.value.members } } : board;
  }

  /** Invites `login` to a GitHub board (or changes its role). */
  setMember(actor: Visitor | undefined, id: string, login: unknown, role: unknown): BoardResult {
    const allowed = this.managed(actor, id);
    if (!allowed.ok) return allowed;
    if (!isGitHubLogin(login)) return fail('invalid', 'login must be a GitHub login');
    if (!isMemberRole(role)) return fail('invalid', 'role must be editor or viewer');
    if (this.admins.has(login)) return fail('invalid', 'admins already own every GitHub board');
    return this.store.update<BoardResult>(boards => {
      const board = own(boards, id);
      if (!board || board.owner.kind !== 'github') return fail('not_found', 'board not found');
      board.members[login.toLowerCase()] = role;
      return { ok: true, value: board };
    });
  }

  removeMember(actor: Visitor | undefined, id: string, login: unknown): BoardResult {
    const allowed = this.managed(actor, id);
    if (!allowed.ok) return allowed;
    if (!isGitHubLogin(login)) return fail('invalid', 'login must be a GitHub login');
    return this.store.update<BoardResult>(boards => {
      const board = own(boards, id);
      if (!board || board.owner.kind !== 'github') return fail('not_found', 'board not found');
      const key = login.toLowerCase();
      if (own(board.members, key) === undefined) return fail('not_found', 'not a member');
      delete board.members[key];
      return { ok: true, value: board };
    });
  }
}
