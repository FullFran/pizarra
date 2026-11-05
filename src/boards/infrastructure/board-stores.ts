import { LockedJsonFile } from '../../shared/locked-json-file.js';
import type { Board } from '../domain/board.js';
import type { BoardStore } from '../application/ports.js';

interface BoardsFile {
  version: 1;
  boards: Record<string, Board>;
}

function own<T>(map: Record<string, T>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

/**
 * `boards.json` in the data directory (0600, atomic writes), shared with
 * the other gateways and the canvas container under the same cross-process
 * lock mechanism as `auth-store.json`.
 */
export class JsonBoardStore implements BoardStore {
  private readonly file: LockedJsonFile<BoardsFile>;

  constructor(path: string) {
    this.file = new LockedJsonFile<BoardsFile>(path, {
      empty: () => ({ version: 1, boards: {} }),
      parse: (raw, file) => {
        const parsed = raw as Partial<BoardsFile>;
        if (parsed.version !== 1 || !parsed.boards || typeof parsed.boards !== 'object') throw new Error(`Unsupported boards file ${file}`);
        return { version: 1, boards: parsed.boards };
      }
    });
  }

  get(id: string): Board | undefined {
    const board = own(this.file.read().boards, id);
    return board ? structuredClone(board) : undefined;
  }

  list(): Board[] {
    return Object.values(this.file.read().boards).map(board => structuredClone(board));
  }

  update<R>(change: (boards: Record<string, Board>) => R): R {
    return this.file.transact(data => change(data.boards));
  }
}

/** Boards kept in memory (no data directory: a local canvas without durable state). */
export class MemoryBoardStore implements BoardStore {
  private readonly boards: Record<string, Board> = {};

  get(id: string): Board | undefined {
    const board = own(this.boards, id);
    return board ? structuredClone(board) : undefined;
  }

  list(): Board[] {
    return Object.values(this.boards).map(board => structuredClone(board));
  }

  update<R>(change: (boards: Record<string, Board>) => R): R {
    return change(this.boards);
  }
}
