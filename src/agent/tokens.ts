import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes } from 'node:crypto';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

export const ENGINE_TOKEN_PREFIX = 'pze_';

export interface EngineGrant {
  login: string;
  board: string;
  /** Seconds since epoch. */
  expiresAt: number;
}

/**
 * Bearers the gateway gives its own engine processes for one board's `/mcp`. Random, kept only
 * as a SHA-256 hash in memory, bound to one person and one board, short-lived, and not JWTs, so
 * no other token verifier accepts one.
 */
export class EngineTokens {
  private readonly live = new Map<string, EngineGrant & { expiresMs: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  mint(grant: { login: string; board: string }, ttlMs: number): string {
    this.sweep();
    // base64url has no `$` and the value never starts with `!`, so an MCP client that
    // expands variables or commands in header values finds nothing to expand.
    const token = `${ENGINE_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
    const expiresMs = this.now() + ttlMs;
    this.live.set(sha256(token), { login: grant.login.toLowerCase(), board: grant.board, expiresAt: Math.floor(expiresMs / 1000), expiresMs });
    return token;
  }

  /** What a live token was minted for, found by hash and never by comparing secrets. */
  resolve(token: string): EngineGrant | null {
    if (!token.startsWith(ENGINE_TOKEN_PREFIX)) return null;
    const hash = sha256(token);
    const entry = this.live.get(hash);
    if (!entry) return null;
    if (entry.expiresMs <= this.now()) {
      this.live.delete(hash);
      return null;
    }
    return { login: entry.login, board: entry.board, expiresAt: entry.expiresAt };
  }

  revoke(token: string): void {
    this.live.delete(sha256(token));
  }

  get size(): number {
    return this.live.size;
  }

  private sweep(): void {
    const now = this.now();
    for (const [hash, entry] of this.live) if (entry.expiresMs <= now) this.live.delete(hash);
  }
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const PROXY_HEADERS = new Set(['forwarded', 'via', 'x-real-ip', 'cf-connecting-ip', 'true-client-ip']);

/**
 * An engine token is only honoured on a direct loopback connection. A reverse proxy on the same
 * host also connects from loopback, so a request that carries any header a proxy adds is treated
 * as coming from outside. A proxy that adds none of these cannot be told apart from the engine:
 * docs/agent.md says what that exposes.
 */
export function isDirectLoopback(remoteAddress: string | undefined, headers: IncomingHttpHeaders): boolean {
  if (!remoteAddress || !LOOPBACK.has(remoteAddress)) return false;
  return Object.keys(headers).every(name => {
    const lower = name.toLowerCase();
    return !PROXY_HEADERS.has(lower) && !lower.startsWith('x-forwarded-');
  });
}

export interface ConnectionInfo {
  remoteAddress: string | undefined;
  headers: IncomingHttpHeaders;
}

/**
 * The connection of the request being authenticated, visible to the engine identity provider
 * only while `/mcp` authenticates it. Everywhere else it is unset, so an engine token is refused.
 */
const connection = new AsyncLocalStorage<ConnectionInfo>();

export function withConnection<T>(req: IncomingMessage, fn: () => T): T {
  return connection.run({ remoteAddress: req.socket.remoteAddress, headers: req.headers }, fn);
}

/**
 * Whether the request being authenticated is an engine's: a direct loopback connection, with no
 * proxy header, addressed to the host the engine dials (`expectedHost`, `127.0.0.1:<port>`).
 */
export function engineConnectionCheck(expectedHost: string): () => boolean {
  return () => {
    const info = connection.getStore();
    return info !== undefined && isDirectLoopback(info.remoteAddress, info.headers) && info.headers.host === expectedHost;
  };
}
