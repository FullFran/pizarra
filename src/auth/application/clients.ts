import {
  ClientError, MAX_REGISTERED_CLIENTS, clientFromMetadataDocument, isCimdClientId, isValidClientIdShape,
  metadataCacheSeconds, parseRegistration
} from '../domain/client.js';
import type { RegisteredClient, ResolvedClient } from '../domain/client.js';
import { MetadataFetchError } from './ports.js';
import type { Clock, ClientMetadataFetcher, Hasher, RandomSource, TokenStore } from './ports.js';
import { nowSeconds } from './ports.js';

const MAX_CACHE_ENTRIES = 100;

/** Registers (DCR), resolves (DCR or CIMD) and authenticates OAuth clients. */
export class ClientRegistry {
  private readonly cache = new Map<string, { client: ResolvedClient; expiresAt: number }>();

  constructor(
    private readonly store: TokenStore,
    private readonly metadata: ClientMetadataFetcher,
    private readonly hasher: Hasher,
    private readonly random: RandomSource,
    private readonly clock: Clock
  ) {}

  /** RFC 7591 registration. Returns the registration response body. */
  register(body: unknown): Record<string, unknown> {
    const request = parseRegistration(body);
    if (this.store.clientCount() >= MAX_REGISTERED_CLIENTS) {
      throw new ClientError('invalid_client_metadata', 'client registration limit reached');
    }
    const clientId = `dcr_${this.random.token(18)}`;
    const secret = request.authMethod === 'none' ? undefined : this.random.token(32);
    const now = nowSeconds(this.clock);
    const client: RegisteredClient = {
      clientId,
      ...(request.clientName ? { clientName: request.clientName } : {}),
      redirectUris: request.redirectUris,
      authMethod: request.authMethod,
      ...(secret ? { secretHash: this.hasher.sha256Hex(secret) } : {}),
      createdAt: now
    };
    this.store.addClient(client);
    return {
      client_id: clientId,
      client_id_issued_at: now,
      ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
      ...(request.clientName ? { client_name: request.clientName } : {}),
      redirect_uris: request.redirectUris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: request.authMethod
    };
  }

  async resolve(clientId: unknown): Promise<ResolvedClient> {
    if (!isValidClientIdShape(clientId)) throw new ClientError('invalid_client', 'missing or invalid client_id');
    if (isCimdClientId(clientId)) return this.resolveMetadataDocument(clientId);
    const registered = this.store.getClient(clientId);
    if (!registered) throw new ClientError('invalid_client', 'unknown client_id');
    return { ...registered, kind: 'dcr' };
  }

  /** Public clients prove possession through PKCE; a stray secret is ignored. */
  authenticate(client: ResolvedClient, presentedSecret: string | undefined): boolean {
    if (client.authMethod === 'none') return true;
    if (!client.secretHash || !presentedSecret) return false;
    return this.hasher.constantTimeEqual(this.hasher.sha256Hex(presentedSecret), client.secretHash);
  }

  private async resolveMetadataDocument(clientId: string): Promise<ResolvedClient> {
    const cached = this.cache.get(clientId);
    if (cached && cached.expiresAt > this.clock.nowMs()) return cached.client;
    let response;
    try {
      response = await this.metadata.fetch(clientId);
    } catch (error) {
      const reason = error instanceof MetadataFetchError ? error.message : 'fetch failed';
      throw new ClientError('invalid_client', `cannot fetch client metadata document: ${reason}`);
    }
    if (response.status !== 200) {
      throw new ClientError('invalid_client', `client metadata document answered HTTP ${response.status}`);
    }
    const client = clientFromMetadataDocument(clientId, response.body);
    if (this.cache.size >= MAX_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(clientId, { client, expiresAt: this.clock.nowMs() + metadataCacheSeconds(response.cacheControl) * 1000 });
    return client;
  }
}
