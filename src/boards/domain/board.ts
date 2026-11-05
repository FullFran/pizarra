/** The board today's single canvas becomes; `/mcp` and the unprefixed paths are its alias. */
export const MAIN_BOARD = 'main';

/** Lowercase letters, digits and dashes, 1-63 characters, starting with a letter or digit. */
const BOARD_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const GITHUB_LOGIN = /^[a-z0-9](?:[a-z0-9-]{0,38})$/i;

export function isBoardId(value: unknown): value is string {
  return typeof value === 'string' && BOARD_ID.test(value);
}

export function isGitHubLogin(value: unknown): value is string {
  return typeof value === 'string' && GITHUB_LOGIN.test(value);
}

/** What a person may do on a board. */
export type Role = 'owner' | 'editor' | 'viewer';
/** Roles that can be given to a member (the owner is the board's owner). */
export type MemberRole = 'editor' | 'viewer';

export function isMemberRole(value: unknown): value is MemberRole {
  return value === 'editor' || value === 'viewer';
}

/**
 * Who owns a board: GitHub boards are run by the admins
 * (`ALLOWED_GITHUB_LOGINS`) and the members they invite; an issuer's board
 * is opened only by that trusted issuer's tickets, which also carry the role.
 */
export type BoardOwner = { kind: 'github'; login?: string } | { kind: 'issuer'; issuer: string };

export interface Board {
  id: string;
  name: string;
  owner: BoardOwner;
  /** GitHub members by lowercase login (GitHub boards only). */
  members: Record<string, MemberRole>;
  /** Seconds since epoch. */
  createdAt: number;
}

/** Whoever is asking, as the boards see them. */
export type Visitor =
  | { kind: 'github'; login: string; admin: boolean }
  | { kind: 'issuer'; issuer: string; role: MemberRole };

function own<T>(map: Record<string, T>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

/**
 * The role `visitor` has on `board`, or undefined (no access):
 * - GitHub board: admins and the owner login are owners, members have their
 *   role; issuer tickets never open it.
 * - Issuer board: only tickets from that issuer, with the ticket's role;
 *   GitHub accounts (admins included) never open it.
 */
export function roleOn(board: Board, visitor: Visitor): Role | undefined {
  if (board.owner.kind === 'github') {
    if (visitor.kind !== 'github') return undefined;
    if (visitor.admin) return 'owner';
    const login = visitor.login.toLowerCase();
    if (board.owner.login && board.owner.login.toLowerCase() === login) return 'owner';
    return own(board.members, login);
  }
  if (visitor.kind !== 'issuer' || visitor.issuer !== board.owner.issuer) return undefined;
  return visitor.role;
}

/** Owners and editors change the board; viewers only read it. */
export function mayWrite(role: Role): boolean {
  return role !== 'viewer';
}

/** Members are managed by a GitHub board's owners; an issuer decides its own boards' membership through tickets. */
export function mayManageMembers(board: Board, role: Role | undefined): boolean {
  return board.owner.kind === 'github' && role === 'owner';
}
