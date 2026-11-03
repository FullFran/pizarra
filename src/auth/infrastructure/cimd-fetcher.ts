import { MetadataFetchError } from '../application/ports.js';
import type { ClientMetadataFetcher } from '../application/ports.js';
import { SafeFetchError, safeFetch } from './ssrf-fetch.js';
import type { SafeFetchOptions } from './ssrf-fetch.js';

/**
 * Fetches Client ID Metadata Documents with the SSRF-safe fetch: https only,
 * public addresses only (pinned), no redirects, bounded time and size, one
 * retry on a transient DNS failure. Tests may inject a guard and a CA.
 */
export class SafeClientMetadataFetcher implements ClientMetadataFetcher {
  constructor(private readonly options: SafeFetchOptions = {}) {}

  async fetch(url: string): Promise<{ status: number; cacheControl?: string; body: string }> {
    try {
      const response = await safeFetch(url, this.options);
      const header = response.headers['cache-control'];
      const cacheControl = Array.isArray(header) ? header.join(',') : header;
      return { status: response.status, ...(cacheControl !== undefined ? { cacheControl } : {}), body: response.body };
    } catch (error) {
      if (error instanceof SafeFetchError) throw new MetadataFetchError(error.message);
      throw new MetadataFetchError('fetch failed');
    }
  }
}
