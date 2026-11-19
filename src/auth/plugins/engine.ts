import type { Identity, IdentityProvider, ProviderAnswer, Target } from '../application/identity.js';
import { AuthConfigError } from '../infrastructure/config-error.js';
import type { AuthPluginDefinition } from './types.js';

export const ENGINE_PROVIDER = 'engine';
const TOKEN_PREFIX = 'pze_';

/** What a live engine token stands for. */
export interface EngineGrantInfo {
  login: string;
  board: string;
  /** Seconds since epoch. */
  expiresAt: number;
}

export interface EnginePluginConfig {
  /** Resolves a live engine token; the composition root supplies the agent's token store. */
  resolve(token: string): EngineGrantInfo | null;
  /** True only while the request being authenticated is a direct loopback connection of an engine. */
  isEngineConnection(): boolean;
}

/**
 * Adapter (c): the agent's own engine processes, acting for one person on one board. Its bearers
 * (`pze_…`) are accepted only on a direct loopback connection, only for the board they were
 * minted for, and only where the gateway marks the connection (`/mcp`). The principal it yields
 * is limited to that board; the board's own rules still decide its role.
 */
export class EngineProvider implements IdentityProvider {
  readonly id = ENGINE_PROVIDER;

  constructor(private readonly config: EnginePluginConfig) {}

  bearer(token: string, target: Target): ProviderAnswer {
    if (!token.startsWith(TOKEN_PREFIX)) return { kind: 'none' };
    if (!this.config.isEngineConnection()) return { kind: 'invalid', error: 'invalid_token' };
    const grant = this.config.resolve(token);
    if (!grant) return { kind: 'invalid', error: 'invalid_token' };
    // One board only: a token for another board, or for a request that names none, is refused.
    if (target.board === undefined || target.board !== grant.board) return { kind: 'invalid', error: 'invalid_token' };
    const identity: Identity = {
      provider: this.id, subject: grant.login, via: 'bearer', board: grant.board, scopes: ['whiteboard'], expiresAt: grant.expiresAt
    };
    return { kind: 'ok', identity };
  }
}

/** Turned on by `PIZARRA_AGENT=1` in the composition root, never by `AUTH_PROVIDERS`. */
export const enginePlugin: AuthPluginDefinition<EnginePluginConfig> = {
  id: ENGINE_PROVIDER,

  missing: () => [],

  configure() {
    throw new AuthConfigError('AUTH_PROVIDERS cannot list "engine": it is enabled by PIZARRA_AGENT=1.');
  },

  build(_context, config) {
    return { provider: new EngineProvider(config) };
  }
};
