import { ClientError } from '../domain/client.js';
import type { ResolvedClient } from '../domain/client.js';
import { PKCE_METHOD, isValidCodeChallenge } from '../domain/pkce.js';
import { redirectUriMatches } from '../domain/redirect-uri.js';
import { chooseResource } from '../domain/resource.js';
import { WHITEBOARD_SCOPE, onlyKnownScopes, requestedScopes } from '../domain/scope.js';
import type { AuthorizationCodes } from './authorization-codes.js';
import type { ClientRegistry } from './clients.js';
import type { SessionService } from './sessions.js';
import type { AuthSettings } from './settings.js';
import type { Clock, RandomSource, TicketSigner } from './ports.js';
import { nowSeconds } from './ports.js';

const CONSENT_PURPOSE = 'consent';
const CONSENT_TTL_SECONDS = 600;

export interface AuthorizeQuery {
  clientId: unknown;
  redirectUri: string | undefined;
  responseType: string | undefined;
  codeChallenge: string | undefined;
  codeChallengeMethod: string | undefined;
  scope: string | undefined;
  resource: unknown;
  state: string | undefined;
}

export interface ConsentView {
  clientName?: string;
  clientId: string;
  clientKind: 'dcr' | 'cimd';
  redirectUri: string;
  scope: string;
  login: string;
  ticket: string;
}

/** Redirect to the client; RFC 9207 `iss` is always included. */
export interface ClientRedirect {
  kind: 'redirect';
  redirectUri: string;
  params: Record<string, string>;
}

export interface ErrorPage {
  kind: 'error_page';
  status: number;
  title: string;
  message: string;
}

export type BeginResult = ErrorPage | ClientRedirect | { kind: 'login' } | { kind: 'consent'; view: ConsentView };
export type DecideResult = ErrorPage | ClientRedirect;

interface ConsentTicket extends Record<string, unknown> {
  tid: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  resource: string;
  state: string | null;
  sid: string;
  login: string;
}

function errorPage(status: number, title: string, message: string): ErrorPage {
  return { kind: 'error_page', status, title, message };
}

/** The authorization endpoint: request validation, consent, code issuance. */
export class AuthorizationService {
  // consent ticket id -> expiry (epoch seconds); tickets are single use
  private readonly usedTickets = new Map<string, number>();

  constructor(
    private readonly settings: AuthSettings,
    private readonly clients: ClientRegistry,
    private readonly sessions: SessionService,
    private readonly codes: AuthorizationCodes,
    private readonly signer: TicketSigner,
    private readonly random: RandomSource,
    private readonly clock: Clock
  ) {}

  redirect(redirectUri: string, params: Record<string, string | undefined>): ClientRedirect {
    const clean: Record<string, string> = {};
    for (const [name, value] of Object.entries(params)) if (value !== undefined) clean[name] = value;
    clean.iss = this.settings.issuer;
    return { kind: 'redirect', redirectUri, params: clean };
  }

  async begin(query: AuthorizeQuery, sessionValue: string | undefined): Promise<BeginResult> {
    let client: ResolvedClient;
    try {
      client = await this.clients.resolve(query.clientId);
    } catch (error) {
      if (error instanceof ClientError) return errorPage(400, 'Unknown application', error.message);
      throw error;
    }
    const redirectUri = query.redirectUri;
    if (!redirectUri || !redirectUriMatches(client.redirectUris, redirectUri)) {
      // Never redirect to an unregistered URI.
      return errorPage(400, 'Invalid redirect', 'redirect_uri is missing or not registered for this client.');
    }
    const fail = (error: string, description: string): ClientRedirect =>
      this.redirect(redirectUri, { error, error_description: description, state: query.state });

    if (query.responseType !== 'code') return fail('unsupported_response_type', 'response_type must be code');
    const challenge = query.codeChallenge;
    if (!challenge) return fail('invalid_request', 'PKCE code_challenge is required');
    if (query.codeChallengeMethod !== PKCE_METHOD) return fail('invalid_request', 'code_challenge_method must be S256');
    if (!isValidCodeChallenge(challenge)) return fail('invalid_request', 'malformed code_challenge');
    if (!onlyKnownScopes(requestedScopes(query.scope))) return fail('invalid_scope', `only the "${WHITEBOARD_SCOPE}" scope is available`);
    const resource = chooseResource(query.resource, this.settings.resources);
    if (!resource.ok) return fail('invalid_target', `resource must be one of ${this.settings.resources.join(', ')}`);

    const session = this.sessions.read(sessionValue);
    if (!session) return { kind: 'login' };
    const ticket = this.signer.sign(CONSENT_PURPOSE, {
      tid: this.random.token(16),
      clientId: client.clientId,
      redirectUri,
      codeChallenge: challenge,
      scope: WHITEBOARD_SCOPE,
      resource: resource.resource,
      state: query.state ?? null,
      sid: session.sid,
      login: session.login
    } satisfies ConsentTicket, CONSENT_TTL_SECONDS);
    return {
      kind: 'consent',
      view: {
        ...(client.clientName ? { clientName: client.clientName } : {}),
        clientId: client.clientId,
        clientKind: client.kind,
        redirectUri,
        scope: WHITEBOARD_SCOPE,
        login: session.login,
        ticket
      }
    };
  }

  /** The consent form answer. The ticket is single use, whatever the decision. */
  async decide(ticketValue: string | undefined, decision: string | undefined, sessionValue: string | undefined): Promise<DecideResult> {
    const session = this.sessions.read(sessionValue);
    const ticket = this.signer.verify<ConsentTicket>(CONSENT_PURPOSE, ticketValue);
    if (!session || !ticket || typeof ticket.tid !== 'string' || ticket.sid !== session.sid || ticket.login !== session.login) {
      return errorPage(400, 'Request expired', 'This approval request expired or belongs to another session. Start again from the application.');
    }
    // Burnt before any await.
    const now = nowSeconds(this.clock);
    for (const [id, expiresAt] of this.usedTickets) if (expiresAt <= now) this.usedTickets.delete(id);
    if (this.usedTickets.has(ticket.tid)) {
      return errorPage(400, 'Request already used', 'This approval request was already answered. Start again from the application.');
    }
    this.usedTickets.set(ticket.tid, ticket.exp);
    // The client could have changed its metadata document since the consent
    // page was shown; re-check the redirect against it.
    let client: ResolvedClient;
    try {
      client = await this.clients.resolve(ticket.clientId);
    } catch (error) {
      if (error instanceof ClientError) return errorPage(400, 'Unknown application', error.message);
      throw error;
    }
    if (!redirectUriMatches(client.redirectUris, ticket.redirectUri)) {
      return errorPage(400, 'Invalid redirect', 'redirect_uri is no longer registered for this client.');
    }
    const state = ticket.state ?? undefined;
    if (decision !== 'approve') {
      return this.redirect(ticket.redirectUri, { error: 'access_denied', error_description: 'the user denied access', state });
    }
    const code = this.codes.issue({
      clientId: client.clientId,
      redirectUri: ticket.redirectUri,
      codeChallenge: ticket.codeChallenge,
      scope: ticket.scope,
      resource: ticket.resource,
      login: session.login,
      expiresAt: nowSeconds(this.clock) + this.settings.authorizationCodeTtlSeconds
    });
    return this.redirect(ticket.redirectUri, { code, state });
  }
}
