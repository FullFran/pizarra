import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
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
 */
export class HmacTicketSigner implements TicketSigner {
  private readonly key: Buffer;

  constructor(secret: Buffer, private readonly clock: Clock = systemClock) {
    this.key = createHmac('sha256', secret).update('pizarra/signer/v1').digest();
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
