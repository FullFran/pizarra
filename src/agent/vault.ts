import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCredential } from './protocol.js';
import type { StoredCredential } from './protocol.js';

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

/** The stored credential cannot be read: wrong key, damaged file or another person's file. */
export class VaultError extends Error {
  constructor() {
    super('stored credential is unreadable');
  }
}

/**
 * One encrypted file per person under `<dataDir>/agent/credentials`. The file name is a hash of
 * the (lower-cased) login and the login is bound into the ciphertext as AAD, so a file moved to
 * another person's name does not decrypt. Callers serialize writes per person.
 */
export class CredentialVault {
  private readonly dir: string;

  constructor(dataDir: string, private readonly key: Buffer) {
    if (key.length !== 32) throw new Error('the vault key must be 32 bytes');
    this.dir = join(dataDir, 'agent', 'credentials');
  }

  pathFor(login: string): string {
    return join(this.dir, `${sha256(login.toLowerCase())}.json`);
  }

  /** The credential, or null when the person has none; throws `VaultError` when the file is unusable. */
  read(login: string): StoredCredential | null {
    const subject = login.toLowerCase();
    let raw: string;
    try {
      raw = readFileSync(this.pathFor(subject), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new VaultError();
    }
    try {
      const file = JSON.parse(raw) as { v?: unknown; iv?: unknown; tag?: unknown; data?: unknown };
      if (file.v !== 1 || typeof file.iv !== 'string' || typeof file.tag !== 'string' || typeof file.data !== 'string') throw new Error();
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(file.iv, 'base64'));
      decipher.setAAD(Buffer.from(subject, 'utf8'));
      decipher.setAuthTag(Buffer.from(file.tag, 'base64'));
      const plain = Buffer.concat([decipher.update(Buffer.from(file.data, 'base64')), decipher.final()]).toString('utf8');
      const credential = parseCredential(JSON.parse(plain));
      if (!credential) throw new Error();
      return credential;
    } catch {
      // Never surface the cause: it could quote file content.
      throw new VaultError();
    }
  }

  write(login: string, credential: StoredCredential): void {
    const subject = login.toLowerCase();
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(subject, 'utf8'));
    const data = Buffer.concat([cipher.update(JSON.stringify(credential), 'utf8'), cipher.final()]);
    const body = JSON.stringify({ v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') });
    const target = this.pathFor(subject);
    const temp = `${target}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      writeFileSync(temp, body, { mode: 0o600, flag: 'wx' });
      renameSync(temp, target);
    } catch (error) {
      rmSync(temp, { force: true });
      throw error;
    }
  }

  delete(login: string): void {
    rmSync(this.pathFor(login), { force: true });
  }
}
