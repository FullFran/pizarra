import type { Board } from '../domain/board.js';

export interface Clock {
  /** Milliseconds since epoch. */
  nowMs(): number;
}

/**
 * Durable boards and memberships, shared by every gateway and the canvas
 * container (one file in the data directory). `update` is atomic across
 * processes: decisions taken inside it (does the board exist, who owns it)
 * see the latest state.
 */
export interface BoardStore {
  get(id: string): Board | undefined;
  list(): Board[];
  update<R>(change: (boards: Record<string, Board>) => R): R;
}

/** The GitHub logins that administer this pizarra (`ALLOWED_GITHUB_LOGINS`). */
export interface Admins {
  has(login: string): boolean;
}
