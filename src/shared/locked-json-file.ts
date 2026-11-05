import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';

/** A lock older than this was left by a process that died while holding it (holders keep it for milliseconds). */
const STALE_LOCK_MS = 10_000;
/** Waiting longer than this for the lock is an error. */
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_RETRY_MS = 5;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export interface LockedJsonFileOptions<T> {
  /** Contents when the file does not exist yet. */
  empty: () => T;
  /** Turns the parsed JSON into `T`; throws on an unsupported format. */
  parse: (raw: unknown, path: string) => T;
  /** Opaque random token source (lock owner tokens, temporary file names). */
  token?: (bytes: number) => string;
}

/**
 * One JSON file shared by several processes (two gateways during a
 * blue-green deploy, a gateway and the canvas container), written
 * atomically with mode 0600.
 *
 * Reads re-load the file when it changed on disk (inode, size, mtime).
 * Every change is a transaction: take a lock directory next to the file
 * (mkdir is atomic across processes and containers on one host) holding the
 * owner's token, re-load, change, write, release only if still the owner. A
 * lock left by a process that died (older than 10 s) is broken under a
 * separate break mutex, so only one waiter removes it. Decisions taken
 * inside a transaction (single use, membership changes) are therefore
 * exact across processes.
 */
export class LockedJsonFile<T> {
  private data: T;
  /** Identity of the file version in `data`; a rename always changes the inode. */
  private stamp = '';
  private readonly lockPath: string;
  private readonly breakPath: string;
  private readonly token: (bytes: number) => string;

  constructor(readonly path: string, private readonly options: LockedJsonFileOptions<T>) {
    this.lockPath = `${path}.lock`;
    this.breakPath = `${path}.lock.break`;
    this.token = options.token ?? (bytes => randomBytes(bytes).toString('base64url'));
    this.data = options.empty();
    this.refresh();
  }

  private fileStamp(): string {
    try {
      const stat = statSync(this.path);
      return `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'none';
      throw error;
    }
  }

  /** Re-loads the file if another process (or this one) replaced it since the last load. */
  private refresh(): void {
    const stamp = this.fileStamp();
    if (stamp === this.stamp) return;
    this.data = this.load();
    this.stamp = stamp;
  }

  private load(): T {
    if (!existsSync(this.path)) return this.options.empty();
    return this.options.parse(JSON.parse(readFileSync(this.path, 'utf8')), this.path);
  }

  private owner(lockPath: string): string | undefined {
    try {
      return readFileSync(join(lockPath, 'owner'), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return undefined;
      throw error;
    }
  }

  /** Takes the lock; returns this holder's token. */
  private lock(): string {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const token = this.token(12);
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
      let created = false;
      try {
        mkdirSync(this.lockPath, { mode: 0o700 });
        created = true;
        // Exclusive: if a breaker swapped the directory meanwhile, at most one process becomes its owner.
        writeFileSync(join(this.lockPath, 'owner'), token, { mode: 0o600, flag: 'wx' });
        return token;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // Lost the race: the directory exists (EEXIST), was moved away (ENOENT) or got another owner (EEXIST).
        if (code !== 'EEXIST' && !(created && code === 'ENOENT')) throw error;
      }
      if (this.breakIfStale()) continue;
      if (Date.now() > deadline) throw new Error(`Timed out waiting for the lock ${this.lockPath}`);
      sleepSync(LOCK_RETRY_MS);
    }
  }

  private isStale(path: string): boolean {
    try {
      return Date.now() - statSync(path).mtimeMs > STALE_LOCK_MS;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  /**
   * Removes the lock if its holder died (stale); true when the caller should
   * retry at once. Breaking takes its own mutex (`.lock.break`), and the
   * staleness is checked again inside it: while a stale lock exists nobody
   * can create a new one, and no other breaker can act, so exactly one
   * process removes exactly the stale lock.
   */
  private breakIfStale(): boolean {
    if (!this.isStale(this.lockPath)) return false;
    try {
      mkdirSync(this.breakPath, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // A breaker that died mid-break (it holds this for microseconds).
      if (this.isStale(this.breakPath)) rmSync(this.breakPath, { recursive: true, force: true });
      return false;
    }
    try {
      if (this.isStale(this.lockPath)) rmSync(this.lockPath, { recursive: true, force: true });
    } finally {
      rmSync(this.breakPath, { recursive: true, force: true });
    }
    return true;
  }

  private unlock(token: string): void {
    // Only the owner removes it: after a stale break the name may hold someone else's lock.
    if (this.owner(this.lockPath) === token) rmSync(this.lockPath, { recursive: true, force: true });
  }

  /** The current contents (re-loaded if the file changed). Do not mutate it outside `transact`. */
  read(): T {
    this.refresh();
    return this.data;
  }

  /**
   * Runs `change` on the current file contents under the lock (after
   * `prepare`, e.g. pruning expired entries), then writes the result.
   */
  transact<R>(change: (data: T) => R, prepare?: (data: T) => void): R {
    const token = this.lock();
    try {
      this.data = this.load();
      prepare?.(this.data);
      const result = change(this.data);
      this.save();
      return result;
    } catch (error) {
      // `data` may hold a change that never reached the file: re-load on the next read.
      this.stamp = '';
      throw error;
    } finally {
      this.unlock(token);
    }
  }

  private save(): void {
    const temporary = `${this.path}.${process.pid}.${this.token(6)}.tmp`;
    const descriptor = openSync(temporary, 'wx', 0o600);
    try {
      writeSync(descriptor, JSON.stringify(this.data));
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    try {
      renameSync(temporary, this.path);
    } catch (error) {
      try { unlinkSync(temporary); } catch { /* already gone */ }
      throw error;
    }
    chmodSync(this.path, 0o600);
    this.stamp = this.fileStamp();
  }
}
