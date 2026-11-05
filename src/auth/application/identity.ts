import type { AuthSettings } from './settings.js';

/**
 * Who made a request, as an identity provider vouches for it. Every
 * provider (GitHub, a trusted issuer, the next one) answers with this shape,
 * so nothing outside the provider knows how the person or agent got in.
 */
export interface Identity {
  /** Id of the provider that vouched for it (`github`, `trusted-issuer`, …). */
  provider: string;
  /** Stable id within that provider: a GitHub login, an issuer's opaque `sub`. */
  subject: string;
  /** Display name, when the provider gives one. */
  name?: string;
  /** Issuer of a signed ticket (trusted issuers only). */
  issuer?: string;
  /** Role the credential itself grants (tickets); otherwise the boards decide. */
  role?: 'editor' | 'viewer';
  /** The only board the credential opens, when it is board-scoped. */
  board?: string;
  via: 'bearer' | 'session';
  clientId?: string;
  scopes: string[];
  /** Seconds since epoch (bearer only). */
  expiresAt?: number;
  /** Audience the bearer was issued for. */
  resource?: string;
  token?: string;
}

/** What a request wants to reach. */
export interface Target {
  /** Acceptable audiences (RFC 8707) for a bearer token; the first is the canonical one. */
  resources: readonly string[];
  /** Board the request is for; board-scoped credentials only open this one. */
  board?: string;
  /** Any board will do (static assets shared by every board). */
  anyBoard?: boolean;
}

export type ProviderAnswer =
  /** Not this provider's kind of credential. */
  | { kind: 'none' }
  | { kind: 'ok'; identity: Identity }
  | { kind: 'invalid'; error: 'invalid_token' | 'insufficient_scope' };

/**
 * The plugin port: one way in. Adding another organisation's sign-in means
 * writing one of these (plus, if it needs pages, an HTTP router), and listing
 * its id in `AUTH_PROVIDERS`. Checks are synchronous so every request is
 * decided without waiting; `prepare` may fetch what they need (keys) first.
 */
export interface IdentityProvider {
  readonly id: string;
  /** A bearer token for `target`. */
  bearer?(token: string, target: Target): ProviderAnswer;
  /** A browser session for `target`, from the request's cookies. */
  session?(cookies: ReadonlyMap<string, string>, target: Target): ProviderAnswer;
  /** Called before the checks with the raw bearer, if any (e.g. to fetch a key it has not seen). */
  prepare?(bearer: string | undefined): Promise<void>;
  /** Names of this provider's session cookies present in `cookies`, to clear on sign-out. */
  sessionCookieNames?(cookies: ReadonlyMap<string, string>): string[];
}

/**
 * What the rest of the system decides about the people GitHub sign-in lets
 * in, and about the resources OAuth tokens are issued for. Auth enforces it
 * and knows nothing about boards: the composition root supplies it.
 */
export interface AccessPolicy {
  /** May this GitHub login hold a session at all? */
  maySignIn(login: string): boolean;
  /** A protected resource (RFC 8707 audience) of this server, with its name for the consent page. */
  describeResource(resource: string): { name: string } | undefined;
  /** May `login` use `resource`? */
  mayUse(login: string, resource: string): boolean;
}

/** One canvas, `ALLOWED_GITHUB_LOGINS` for everything: the behaviour before boards existed. */
export class StaticAccessPolicy implements AccessPolicy {
  constructor(private readonly settings: AuthSettings) {}

  maySignIn(login: string): boolean {
    return this.settings.allowedLogins.has(login);
  }

  describeResource(resource: string): { name: string } | undefined {
    return this.settings.resources.includes(resource) ? { name: 'pizarra' } : undefined;
  }

  mayUse(login: string, resource: string): boolean {
    return this.settings.resources.includes(resource) && this.settings.allowedLogins.has(login);
  }
}

/**
 * RFC 8707: the resource a grant is for. Omitted means the default one
 * (`${issuer}/mcp`); when given (once) it must be a resource the policy knows.
 */
export function selectResource(requested: unknown, defaultResource: string, policy: AccessPolicy): { ok: true; resource: string } | { ok: false } {
  const values = requested === undefined ? [] : [requested].flat();
  if (values.length > 1) return { ok: false };
  if (values.length === 0) return { ok: true, resource: defaultResource };
  const value = values[0];
  return typeof value === 'string' && policy.describeResource(value) ? { ok: true, resource: value } : { ok: false };
}
