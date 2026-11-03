import type { IncomingHttpHeaders } from 'node:http';
import type { RequestHandler, Response } from 'express';
import { FixedWindowLimiter } from '../../domain/rate-limit.js';

export function single(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    if (cookies.has(name)) continue;
    try {
      cookies.set(name, decodeURIComponent(part.slice(index + 1).trim()));
    } catch {
      // ignore malformed values
    }
  }
  return cookies;
}

export function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  return /^Bearer\s+([A-Za-z0-9\-._~+/]+=*)\s*$/i.exec(header)?.[1];
}

/** Same origin as `origin`: the `Origin` header, or `Referer` when there is none. */
export function isSameOrigin(headers: IncomingHttpHeaders, origin: string): boolean {
  const presented = single(headers.origin);
  if (presented !== undefined) return presented === origin;
  const referer = single(headers.referer);
  if (!referer) return false;
  try {
    return new URL(referer).origin === origin;
  } catch {
    return false;
  }
}

export type SameSite = 'Lax' | 'Strict';

/** Cookie names and attributes: `__Host-` + Secure on https issuers. */
export class CookieJar {
  readonly session: string;
  readonly device: string;

  constructor(private readonly secure: boolean) {
    const prefix = secure ? '__Host-' : '';
    this.session = `${prefix}wb_session`;
    this.device = `${prefix}wb_device`;
  }

  private attributes(maxAge: number, sameSite: SameSite): string {
    return `Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=${maxAge}${this.secure ? '; Secure' : ''}`;
  }

  set(res: Response, name: string, value: string, maxAge: number, sameSite: SameSite = 'Lax'): void {
    res.append('Set-Cookie', `${name}=${encodeURIComponent(value)}; ${this.attributes(maxAge, sameSite)}`);
  }

  clear(res: Response, name: string, sameSite: SameSite = 'Lax'): void {
    res.append('Set-Cookie', `${name}=; ${this.attributes(0, sameSite)}`);
  }

  read(cookieHeader: string | undefined, name: string): string | undefined {
    return parseCookies(cookieHeader).get(name);
  }
}

/** Fixed-window limit per client IP (`req.ip`, which honours `TRUST_PROXY`). */
export function rateLimit(options: { windowMs: number; max: number; name: string }): RequestHandler {
  const limiter = new FixedWindowLimiter(options.windowMs, options.max);
  return (req, res, next) => {
    const wait = limiter.hit(req.ip ?? req.socket.remoteAddress ?? 'unknown', Date.now());
    if (wait > 0) {
      res.setHeader('Retry-After', String(wait));
      res.status(429).json({ error: 'rate_limited', error_description: `Too many ${options.name} requests; retry later.` });
      return;
    }
    next();
  };
}

export function oauthError(res: Response, status: number, error: string, description: string, extraHeaders: Record<string, string> = {}): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  for (const [name, value] of Object.entries(extraHeaders)) res.setHeader(name, value);
  res.status(status).json({ error, error_description: description });
}
