/**
 * Ports the gateway needs. The auth module satisfies `RequestAuthenticator`
 * structurally; the gateway never imports it (the composition root wires it).
 */
export interface Principal {
  login: string;
  via: 'bearer' | 'session';
  clientId?: string;
  scopes: string[];
  expiresAt?: number;
  resource?: string;
  token?: string;
}

export type Authentication =
  | { ok: true; principal: Principal }
  | { ok: false; status: 401 | 403; error: string; challenge: string };

export interface RequestAuthenticator {
  /** Origin that cookie-authenticated writes must come from. */
  readonly origin: string;
  authenticate(
    headers: { authorization?: string | undefined; cookie?: string | undefined },
    options: { resource: string; acceptSession: boolean }
  ): Authentication;
}

/** The unmodified upstream canvas server, reachable only on loopback. */
export interface CanvasUpstream {
  readonly host: string;
  readonly port: number;
  readonly baseUrl: string;
  isReady(): boolean;
}
