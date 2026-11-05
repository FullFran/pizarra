/**
 * Ports the gateway needs. The auth module satisfies `RequestAuthenticator`
 * and the boards module `BoardDirectory` (both structurally, through the
 * composition root); the gateway imports neither.
 */
export interface Principal {
  login: string;
  /** Identity provider that vouched for it (`github`, `trusted-issuer`, …). */
  provider?: string;
  name?: string;
  issuer?: string;
  /** Role carried by the credential itself (signed tickets). */
  role?: 'editor' | 'viewer';
  /** The only board a board-scoped credential opens. */
  board?: string;
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

export interface CredentialHeaders {
  authorization?: string | undefined;
  cookie?: string | undefined;
}

export interface RequestAuthenticator {
  /** Origin that cookie-authenticated writes must come from. */
  readonly origin: string;
  authenticate(
    headers: CredentialHeaders,
    options: { resource: string | readonly string[]; acceptSession: boolean; board?: string; anyBoard?: boolean }
  ): Authentication;
  /** Lets providers fetch what the check will need (keys) before `authenticate`. */
  prepare?(headers: CredentialHeaders): Promise<void>;
}

export type BoardRole = 'owner' | 'editor' | 'viewer';

export type BoardOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; error: 'not_found' | 'forbidden' | 'invalid' | 'exists'; message: string };

export interface BoardSummary {
  id: string;
  name: string;
  role: BoardRole;
  /** `github` boards take invites; `issuer` boards are opened by their issuer's tickets. */
  kind: 'github' | 'issuer';
}

/**
 * Boards and who may open them. `principal` is undefined when auth is off
 * (a local canvas: everyone is an owner).
 */
export interface BoardDirectory {
  exists(board: string): boolean;
  summary(board: string, principal: Principal | undefined): BoardSummary | undefined;
  list(principal: Principal | undefined): BoardSummary[];
  create(principal: Principal | undefined, id: unknown, name: unknown): BoardOutcome<BoardSummary>;
  members(principal: Principal | undefined, board: string): BoardOutcome<Record<string, 'editor' | 'viewer'>>;
  setMember(principal: Principal | undefined, board: string, login: unknown, role: unknown): BoardOutcome<Record<string, 'editor' | 'viewer'>>;
  removeMember(principal: Principal | undefined, board: string, login: unknown): BoardOutcome<Record<string, 'editor' | 'viewer'>>;
}

/** The canvas the gateway proxies to (the pool's front), reachable only on loopback or a private network. */
export interface CanvasUpstream {
  readonly host: string;
  readonly port: number;
  readonly baseUrl: string;
  isReady(): boolean;
}
