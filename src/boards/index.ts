/**
 * The boards bounded context: boards, their owners and members, and who may
 * open each one with which role. It imports nothing from auth or the
 * gateway; the composition root adapts it to their ports.
 */
import { join } from 'node:path';
import { BoardService } from './application/board-service.js';
import type { Admins, Clock } from './application/ports.js';
import { JsonBoardStore, MemoryBoardStore } from './infrastructure/board-stores.js';

export { BoardService } from './application/board-service.js';
export type { BoardResult, BoardError } from './application/board-service.js';
export { MAIN_BOARD, isBoardId, mayWrite } from './domain/board.js';
export type { Board, Role, MemberRole, Visitor, BoardOwner } from './domain/board.js';
export { JsonBoardStore, MemoryBoardStore } from './infrastructure/board-stores.js';

/** File name of the boards store in the data directory. */
export const BOARDS_FILE = 'boards.json';

export function buildBoards(options: { dataDir?: string; admins: Admins; clock?: Clock }): BoardService {
  const store = options.dataDir ? new JsonBoardStore(join(options.dataDir, BOARDS_FILE)) : new MemoryBoardStore();
  return new BoardService(store, options.admins, options.clock ?? { nowMs: () => Date.now() });
}
