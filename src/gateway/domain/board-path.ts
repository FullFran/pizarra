/** The board unprefixed paths (`/`, `/api/*`, `/mcp`, the WebSocket at `/`) belong to: today's canvas. */
export const DEFAULT_BOARD = 'main';

const BOARD_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

export type BoardPath =
  /** `/b/<id>` or `/b/<id>/<rest>`: `rest` is the path inside that board's canvas (always starts with `/`). */
  | { kind: 'board'; board: string; rest: string; prefixed: true; bare: boolean }
  /** Anything else is board main, at the same path. */
  | { kind: 'board'; board: string; rest: string; prefixed: false; bare: false }
  /** Looks like a board path but is not a valid one (any case of `/b/`, a bad id): refused. */
  | { kind: 'invalid' };

/**
 * Splits a request path into the board it is for and the path inside that
 * board's canvas. The gateway and the canvas pool both route with this one
 * function, so they can never disagree on which board a request reaches.
 * `/B/…` is not an alias of anything: every case of the `/b/` prefix is a
 * board path, and only lowercase `/b/<valid id>` is a valid one.
 */
export function parseBoardPath(path: string): BoardPath {
  if (path.toLowerCase() === '/b' || path.toLowerCase().startsWith('/b/')) {
    if (!path.startsWith('/b/')) return { kind: 'invalid' };
    const slash = path.indexOf('/', 3);
    const board = slash < 0 ? path.slice(3) : path.slice(3, slash);
    if (!BOARD_ID.test(board)) return { kind: 'invalid' };
    return { kind: 'board', board, rest: slash < 0 ? '/' : path.slice(slash), prefixed: true, bare: slash < 0 };
  }
  return { kind: 'board', board: DEFAULT_BOARD, rest: path, prefixed: false, bare: false };
}

/** Path prefix of a board's own URLs. */
export function boardPrefix(board: string): string {
  return `/b/${board}`;
}
