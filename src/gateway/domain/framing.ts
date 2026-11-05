import { isLoopbackOrigin } from './origins.js';

/**
 * `FRAME_ANCESTORS`: exact origins allowed to frame board pages, separated
 * by spaces or commas. `https` only (plain `http` for loopback, in tests);
 * no wildcards, paths or keywords, so the policy is exactly the list.
 */
export function parseFrameAncestors(raw: string | undefined): string[] {
  const origins: string[] = [];
  for (const entry of (raw ?? '').split(/[\s,]+/).filter(Boolean)) {
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      throw new Error(`FRAME_ANCESTORS must list origins like https://app.example.com, got ${JSON.stringify(entry)}`);
    }
    const secure = url.protocol === 'https:' || (url.protocol === 'http:' && isLoopbackOrigin(url.hostname));
    if (!secure || url.origin !== entry.replace(/\/$/, '') || entry.includes('*')) {
      throw new Error(`FRAME_ANCESTORS must list exact https origins (no wildcard, path or plain http), got ${JSON.stringify(entry)}`);
    }
    if (!origins.includes(url.origin)) origins.push(url.origin);
  }
  return origins;
}

/**
 * Framing headers for a response: a board page may be framed by the listed
 * origins (`frame-ancestors <list>`, no `X-Frame-Options`); anything else,
 * and every page when the list is empty, refuses framing. An upstream
 * Content-Security-Policy keeps its other directives.
 */
export function framingHeaders(kind: 'board' | 'other', ancestors: readonly string[], upstreamCsp: string | undefined): { csp: string; xFrameOptions?: 'DENY' } {
  const kept = (upstreamCsp ?? '').split(';').map(part => part.trim()).filter(part => part && !/^frame-ancestors\b/i.test(part));
  const allowed = kind === 'board' && ancestors.length > 0;
  const directive = `frame-ancestors ${allowed ? ancestors.join(' ') : "'none'"}`;
  return { csp: [...kept, directive].join('; '), ...(allowed ? {} : { xFrameOptions: 'DENY' as const }) };
}
