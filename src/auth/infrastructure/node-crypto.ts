import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Clock, Hasher, RandomSource, TicketSigner } from '../application/ports.js';

export const systemClock: Clock = { nowMs: () => Date.now() };

export const cryptoRandom: RandomSource = {
  token: (bytes = 32) => randomBytes(bytes).toString('base64url')
};

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export const sha256Hasher: Hasher = {
  sha256Hex: value => createHash('sha256').update(value, 'utf8').digest('hex'),
  sha256Base64Url: value => createHash('sha256').update(value, 'ascii').digest('base64url'),
  constantTimeEqual
};

/**
 * HMAC-SHA256 signed, expiring JSON values. Each use has its own purpose
 * string, so a value signed for one purpose never verifies as another.
 * Sealed values are AES-256-GCM encrypted (purpose as associated data) with
 * a separate key derived from the same secret, so every gateway sharing the
 * secret can open them.
 */
export class HmacTicketSigner implements TicketSigner {
  private readonly key: Buffer;
  private readonly sealKey: Buffer;

  constructor(secret: Buffer, private readonly clock: Clock = systemClock) {
    this.key = createHmac('sha256', secret).update('pizarra/signer/v1').digest();
    this.sealKey = createHmac('sha256', secret).update('pizarra/sealer/v1').digest();
  }

  seal(purpose: string, payload: Record<string, unknown>, ttlSeconds: number): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.sealKey, iv);
    cipher.setAAD(Buffer.from(purpose, 'utf8'));
    const body = Buffer.from(JSON.stringify({ ...payload, exp: this.now() + ttlSeconds }), 'utf8');
    const data = Buffer.concat([cipher.update(body), cipher.final()]);
    return [iv, data, cipher.getAuthTag()].map(part => part.toString('base64url')).join('.');
  }

  open<T extends Record<string, unknown>>(purpose: string, value: string | undefined): (T & { exp: number }) | null {
    if (!value) return null;
    const parts = value.split('.');
    if (parts.length !== 3) return null;
    const [iv, data, tag] = parts.map(part => Buffer.from(part!, 'base64url'));
    if (iv!.length !== 12 || tag!.length !== 16) return null;
    let parsed: unknown;
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.sealKey, iv!);
      decipher.setAAD(Buffer.from(purpose, 'utf8'));
      decipher.setAuthTag(tag!);
      parsed = JSON.parse(Buffer.concat([decipher.update(data!), decipher.final()]).toString('utf8'));
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== 'object') return null;
    const exp = (parsed as { exp?: unknown }).exp;
    if (typeof exp !== 'number' || exp <= this.now()) return null;
    return parsed as T & { exp: number };
  }

  private mac(purpose: string, data: string): string {
    return createHmac('sha256', this.key).update(`${purpose}\n${data}`).digest('base64url');
  }

  private now(): number {
    return Math.floor(this.clock.nowMs() / 1000);
  }

  sign(purpose: string, payload: Record<string, unknown>, ttlSeconds: number): string {
    const body = { ...payload, exp: this.now() + ttlSeconds };
    const data = Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
    return `${data}.${this.mac(purpose, data)}`;
  }

  verify<T extends Record<string, unknown>>(purpose: string, value: string | undefined): (T & { exp: number }) | null {
    if (!value) return null;
    const dot = value.indexOf('.');
    if (dot <= 0 || dot !== value.lastIndexOf('.')) return null;
    const data = value.slice(0, dot);
    if (!constantTimeEqual(value.slice(dot + 1), this.mac(purpose, data))) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== 'object') return null;
    const exp = (parsed as { exp?: unknown }).exp;
    if (typeof exp !== 'number' || exp <= this.now()) return null;
    return parsed as T & { exp: number };
  }
}
