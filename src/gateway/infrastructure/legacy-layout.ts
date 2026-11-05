import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from '../../shared/logger.js';

/**
 * Moves one directory of the single-canvas layout (`<data>/canvas`,
 * `<data>/files`) to board main's place (`<data>/boards/main/<name>`) the
 * first time a multi-board pizarra starts on it. A rename on the same
 * volume: atomic, nothing copied. If both exist, both are left alone and a
 * warning says so (someone has to choose).
 */
export function migrateToBoardMain(dataRoot: string, name: 'canvas' | 'files', logger: Logger): 'moved' | 'none' | 'conflict' {
  const legacy = join(dataRoot, name);
  const target = join(dataRoot, 'boards', 'main', name);
  if (!existsSync(legacy)) return 'none';
  if (existsSync(target)) {
    logger.warn('Both the single-canvas and the board-main directory exist; using the board-main one', { legacy, target });
    return 'conflict';
  }
  mkdirSync(join(dataRoot, 'boards', 'main'), { recursive: true, mode: 0o700 });
  renameSync(legacy, target);
  logger.info('Moved the single-canvas directory to board main', { from: legacy, to: target });
  return 'moved';
}
