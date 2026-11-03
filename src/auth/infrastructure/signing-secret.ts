import { randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { SecretProvider } from '../application/ports.js';

/** Smallest accepted signing secret (characters of the env/file value). */
export const MIN_SECRET_LENGTH = 32;
/** File in the data directory holding the generated signing secret. */
export const GENERATED_SECRET_FILENAME = 'auth-secret';

export class SecretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretError';
  }
}

export class StaticSecret implements SecretProvider {
  constructor(private readonly value: string) {}
  secret(): Buffer {
    return Buffer.from(this.value, 'utf8');
  }
}

/**
 * Reads the signing secret kept in the data directory, creating it on first
 * start: 48 random bytes, base64, written to a temporary file with mode 0600
 * and hard-linked into place, so a concurrent start never sees a partial file
 * and never overwrites an existing one. An existing file must be private to
 * its owner and long enough, or startup is refused.
 */
export function loadOrCreateGeneratedSecret(dataDir: string): StaticSecret {
  const path = join(dataDir, GENERATED_SECRET_FILENAME);
  const readExisting = (): string => {
    const stat = lstatSync(path);
    if (!stat.isFile()) throw new SecretError(`${path} must be a regular file.`);
    if ((stat.mode & 0o077) !== 0) {
      throw new SecretError(
        `${path} is readable by group or others (mode ${(stat.mode & 0o777).toString(8).padStart(4, '0')}); ` +
        `it holds the session-signing secret and must be 0600. Run \`chmod 600 ${path}\` or delete it to generate a new one (this signs everyone out).`
      );
    }
    const value = readFileSync(path, 'utf8').trim();
    if (value.length < MIN_SECRET_LENGTH) {
      throw new SecretError(`${path} must hold at least ${MIN_SECRET_LENGTH} characters; delete it to generate a new secret.`);
    }
    return value;
  };
  try {
    return new StaticSecret(readExisting());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      if (error instanceof SecretError) throw error;
      throw new SecretError(`Cannot read ${path}: ${(error as Error).message}`);
    }
  }
  try {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const value = randomBytes(48).toString('base64');
    const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    const fd = openSync(temporary, 'wx', 0o600);
    try {
      writeSync(fd, `${value}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      linkSync(temporary, path);
    } catch (error) {
      // Another process created it first: use that one.
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    } finally {
      unlinkSync(temporary);
    }
  } catch (error) {
    throw new SecretError(`Cannot create the signing secret ${path}: ${(error as Error).message}`);
  }
  return new StaticSecret(readExisting());
}
