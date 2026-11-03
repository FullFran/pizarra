import { lstatSync, readdirSync, readFileSync, rmdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

/** Upstream's data-directory lock: `<dir>/canvas-state.lock/owner-<uuid>.json` holding `{pid, token}`. */
const LOCK_DIRECTORY = 'canvas-state.lock';
const OWNER_FILE = /^owner-([0-9a-f-]{36})\.json$/;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

export type LockCheck = 'none' | 'cleared' | 'held' | 'left';

/**
 * Clears the upstream canvas's data-directory lock when its owner is dead,
 * applying upstream's own staleness rule *before* the new canvas is
 * spawned. Upstream would apply it itself, but after a hard kill of a
 * container the new canvas often gets the same pid as the dead one, finds
 * "its own" pid alive and refuses to start forever. The gateway is the only
 * process that spawns canvases on this directory, so a lock whose owner is
 * not running is stale. A live owner is left alone (upstream then refuses,
 * correctly). Anything that does not look like upstream's lock is left for
 * upstream to judge.
 */
export function clearStaleCanvasLock(dataDir: string, isAlive: (pid: number) => boolean = alive): LockCheck {
  const lockDirectory = join(dataDir, LOCK_DIRECTORY);
  try {
    const stat = lstatSync(lockDirectory);
    if (!stat.isDirectory()) return 'left';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'none';
    throw error;
  }
  const entries = readdirSync(lockDirectory);
  if (entries.length !== 1) return 'left';
  const name = entries[0]!;
  const match = OWNER_FILE.exec(name);
  if (!match) return 'left';
  const ownerPath = join(lockDirectory, name);
  if (!lstatSync(ownerPath).isFile()) return 'left';
  let owner: { pid?: unknown; token?: unknown };
  try {
    owner = JSON.parse(readFileSync(ownerPath, 'utf8')) as { pid?: unknown; token?: unknown };
  } catch {
    return 'left';
  }
  if (typeof owner.pid !== 'number' || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || owner.token !== match[1]) return 'left';
  if (owner.pid !== process.pid && isAlive(owner.pid)) return 'held';
  unlinkSync(ownerPath);
  rmdirSync(lockDirectory);
  return 'cleared';
}
