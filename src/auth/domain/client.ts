import { isAllowedRedirectUri, MAX_URI_LENGTH } from './redirect-uri.js';

/** Upper bound on clients registered through DCR (open registration). */
export const MAX_REGISTERED_CLIENTS = 200;
const MAX_REDIRECT_URIS = 10;
const MAX_CLIENT_NAME_LENGTH = 100;

export type ClientAuthMethod = 'none' | 'client_secret_post' | 'client_secret_basic';

export class ClientError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'ClientError';
  }
}

export interface RegisteredClient {
  clientId: string;
  clientName?: string;
  redirectUris: string[];
  authMethod: ClientAuthMethod;
  /** SHA-256 of the client secret, for confidential DCR clients only. */
  secretHash?: string;
  createdAt: number;
}

/** A client as the authorization endpoint sees it, whatever its origin. */
export interface ResolvedClient {
  clientId: string;
  clientName?: string;
  redirectUris: string[];
  authMethod: ClientAuthMethod;
  secretHash?: string;
  kind: 'dcr' | 'cimd';
}

export function validateRedirectUris(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_REDIRECT_URIS) {
    throw new ClientError('invalid_redirect_uri', `redirect_uris must list 1 to ${MAX_REDIRECT_URIS} URIs`);
  }
  for (const uri of value) {
    if (!isAllowedRedirectUri(uri)) {
      throw new ClientError('invalid_redirect_uri', `redirect URI not allowed: ${JSON.stringify(uri)}`);
    }
  }
  return [...new Set(value as string[])];
}

export function validateClientName(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > MAX_CLIENT_NAME_LENGTH) {
    throw new ClientError('invalid_client_metadata', `client_name must be a string of at most ${MAX_CLIENT_NAME_LENGTH} characters`);
  }
  return value;
}

export function validateGrantAndResponseTypes(body: Record<string, unknown>): void {
  const grants = body.grant_types ?? ['authorization_code'];
  if (!Array.isArray(grants) || grants.some(grant => grant !== 'authorization_code' && grant !== 'refresh_token')) {
    throw new ClientError('invalid_client_metadata', 'grant_types may only contain authorization_code and refresh_token');
  }
  const responses = body.response_types ?? ['code'];
  if (!Array.isArray(responses) || responses.some(type => type !== 'code')) {
    throw new ClientError('invalid_client_metadata', 'response_types may only contain code');
  }
}

export interface RegistrationRequest {
  redirectUris: string[];
  clientName?: string;
  authMethod: ClientAuthMethod;
}

/** RFC 7591 registration metadata, validated. */
export function parseRegistration(body: unknown): RegistrationRequest {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ClientError('invalid_client_metadata', 'registration body must be a JSON object');
  }
  const metadata = body as Record<string, unknown>;
  const redirectUris = validateRedirectUris(metadata.redirect_uris);
  const clientName = validateClientName(metadata.client_name);
  validateGrantAndResponseTypes(metadata);
  const method = metadata.token_endpoint_auth_method ?? 'none';
  if (method !== 'none' && method !== 'client_secret_post' && method !== 'client_secret_basic') {
    throw new ClientError('invalid_client_metadata', 'token_endpoint_auth_method must be none, client_secret_post or client_secret_basic');
  }
  return { redirectUris, ...(clientName ? { clientName } : {}), authMethod: method };
}

export function isValidClientIdShape(clientId: unknown): clientId is string {
  return typeof clientId === 'string' && clientId.length > 0 && clientId.length <= MAX_URI_LENGTH;
}

/** Whether a client_id is a Client ID Metadata Document URL. */
export function isCimdClientId(clientId: string): boolean {
  if (!clientId.startsWith('https://')) return false;
  try {
    const url = new URL(clientId);
    return url.pathname !== '/' && !url.hash && !url.username && !url.password;
  } catch {
    return false;
  }
}

/**
 * Validates a fetched Client ID Metadata Document
 * (draft-ietf-oauth-client-id-metadata-document): it must name itself, be a
 * public client and list allowed redirect URIs.
 */
export function clientFromMetadataDocument(clientId: string, body: string): ResolvedClient {
  let document: Record<string, unknown>;
  try {
    const parsed = JSON.parse(body) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    document = parsed as Record<string, unknown>;
  } catch {
    throw new ClientError('invalid_client', 'client metadata document is not a JSON object');
  }
  if (document.client_id !== clientId) {
    throw new ClientError('invalid_client', 'client metadata document client_id does not match its URL');
  }
  const method = document.token_endpoint_auth_method ?? 'none';
  if (method !== 'none') {
    throw new ClientError('invalid_client', 'only public clients (token_endpoint_auth_method "none") are supported for metadata documents');
  }
  if (document.client_secret !== undefined) {
    throw new ClientError('invalid_client', 'client metadata document must not contain a client_secret');
  }
  try {
    const redirectUris = validateRedirectUris(document.redirect_uris);
    const clientName = validateClientName(document.client_name);
    validateGrantAndResponseTypes(document);
    return { clientId, ...(clientName ? { clientName } : {}), redirectUris, authMethod: 'none', kind: 'cimd' };
  } catch (error) {
    throw new ClientError('invalid_client', (error as Error).message);
  }
}

const MIN_CACHE_SECONDS = 60;
const MAX_CACHE_SECONDS = 24 * 3600;
const DEFAULT_CACHE_SECONDS = 300;

/** How long a metadata document is cached, from its Cache-Control header. */
export function metadataCacheSeconds(cacheControl: string | undefined): number {
  const value = cacheControl ?? '';
  if (/no-store|no-cache/i.test(value)) return MIN_CACHE_SECONDS;
  const match = /max-age=(\d+)/i.exec(value);
  const seconds = match ? Number(match[1]) : DEFAULT_CACHE_SECONDS;
  return Math.min(MAX_CACHE_SECONDS, Math.max(MIN_CACHE_SECONDS, seconds));
}
