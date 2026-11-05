/**
 * Adapters between the bounded contexts, used only by the composition
 * roots: the boards module seen through auth's `AccessPolicy` and the
 * gateway's `BoardDirectory`.
 */
import type { AccessPolicy } from './auth/index.js';
import type { BoardService, Role, Visitor } from './boards/index.js';
import { MAIN_BOARD } from './boards/index.js';
import type { BoardDirectory, BoardSummary, Principal } from './gateway/application/ports.js';

/** `${issuer}/mcp` is board main; `${issuer}/b/<id>/mcp` is board `<id>`. */
export function boardOfResource(issuer: string, resource: string): string | undefined {
  if (resource === `${issuer}/mcp`) return MAIN_BOARD;
  const prefix = `${issuer}/b/`;
  if (!resource.startsWith(prefix) || !resource.endsWith('/mcp')) return undefined;
  const board = resource.slice(prefix.length, -'/mcp'.length);
  return /^[a-z0-9][a-z0-9-]{0,62}$/.test(board) ? board : undefined;
}

/** GitHub sign-in and OAuth tokens follow board memberships. */
export function boardsAccessPolicy(boards: BoardService, issuer: string): AccessPolicy {
  return {
    maySignIn: login => boards.maySignIn(login),
    describeResource: resource => {
      const board = boardOfResource(issuer, resource);
      const found = board ? boards.get(board) : undefined;
      // Issuer boards are opened by their issuer's tickets, never by OAuth tokens.
      return found && found.owner.kind === 'github' ? { name: `${found.name} (${found.id})` } : undefined;
    },
    mayUse: (login, resource) => {
      const board = boardOfResource(issuer, resource);
      return board !== undefined && boards.roleFor(board, boards.visitorForLogin(login)) !== undefined;
    }
  };
}

/**
 * How a principal is seen by the boards: a GitHub login (admin or not), or
 * a trusted issuer's ticket with its own role. Any other adapter that
 * vouches with an `issuer` and a `role` is an issuer too.
 */
export function visitorOf(boards: BoardService, principal: Principal): Visitor | undefined {
  if (principal.issuer) {
    return { kind: 'issuer', issuer: principal.issuer, role: principal.role === 'editor' ? 'editor' : 'viewer' };
  }
  if (principal.provider === undefined || principal.provider === 'github') return boards.visitorForLogin(principal.login);
  return undefined;
}

function summary(boards: BoardService, id: string, role: Role): BoardSummary | undefined {
  const board = boards.get(id);
  return board ? { id: board.id, name: board.name, role, kind: board.owner.kind } : undefined;
}

/** The gateway's view of the boards. Without auth (`principal` undefined) everyone owns every board. */
export function boardDirectory(boards: BoardService): BoardDirectory {
  const visitor = (principal: Principal | undefined): Visitor | undefined | 'none' =>
    principal === undefined ? undefined : visitorOf(boards, principal) ?? 'none';
  return {
    exists: id => boards.exists(id),
    summary: (id, principal) => {
      const who = visitor(principal);
      if (who === 'none') return undefined;
      // A board-scoped credential opens its own board only.
      if (principal?.board !== undefined && principal.board !== id) return undefined;
      const role = who === undefined ? (boards.exists(id) ? 'owner' : undefined) : boards.roleFor(id, who);
      return role ? summary(boards, id, role) : undefined;
    },
    list: principal => {
      const who = visitor(principal);
      if (who === 'none') return [];
      const visible = who === undefined
        ? boards.visible({ kind: 'github', login: '-', admin: true }).filter(entry => entry.board.owner.kind === 'github').map(entry => ({ ...entry, role: 'owner' as Role }))
        : boards.visible(who);
      return visible
        .filter(entry => principal?.board === undefined || entry.board.id === principal.board)
        .map(entry => ({ id: entry.board.id, name: entry.board.name, role: entry.role, kind: entry.board.owner.kind }));
    },
    create: (principal, id, name) => {
      const who = visitor(principal);
      if (who === 'none') return { ok: false, error: 'forbidden', message: 'only admins create boards' };
      const created = boards.create(who, id, name);
      return created.ok ? { ok: true, value: { id: created.value.id, name: created.value.name, role: 'owner', kind: 'github' } } : created;
    },
    members: (principal, id) => {
      const who = visitor(principal);
      return who === 'none' ? { ok: false, error: 'not_found', message: 'board not found' } : boards.members(who, id);
    },
    setMember: (principal, id, login, role) => {
      const who = visitor(principal);
      if (who === 'none') return { ok: false, error: 'not_found', message: 'board not found' };
      const changed = boards.setMember(who, id, login, role);
      return changed.ok ? { ok: true, value: { ...changed.value.members } } : changed;
    },
    removeMember: (principal, id, login) => {
      const who = visitor(principal);
      if (who === 'none') return { ok: false, error: 'not_found', message: 'board not found' };
      const changed = boards.removeMember(who, id, login);
      return changed.ok ? { ok: true, value: { ...changed.value.members } } : changed;
    }
  };
}
