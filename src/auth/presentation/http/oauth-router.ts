import express from 'express';
import type { Request, Response } from 'express';
import { ClientError } from '../../domain/client.js';
import { WHITEBOARD_SCOPE } from '../../domain/scope.js';
import { safeReturnPath } from '../../domain/return-path.js';
import type { DeviceOutcome } from '../../domain/device-login.js';
import type { AuthorizationService, ClientRedirect } from '../../application/authorize.js';
import type { ClientRegistry } from '../../application/clients.js';
import type { DeviceSignIn } from '../../application/device-sign-in.js';
import type { SessionService } from '../../application/sessions.js';
import type { AuthSettings } from '../../application/settings.js';
import type { TokenService } from '../../application/tokens.js';
import type { AccessPolicy } from '../../application/identity.js';
import { CookieJar, isSameOrigin, oauthError, rateLimit, single } from './http-helpers.js';
import { sendConsentPage, sendDevicePage, sendDeviceScript, sendErrorPage, sendLoginPage } from './pages.js';

export interface OAuthRouterDeps {
  settings: AuthSettings;
  cookies: CookieJar;
  sessions: SessionService;
  clients: ClientRegistry;
  deviceSignIn: DeviceSignIn;
  authorization: AuthorizationService;
  tokens: TokenService;
  policy: AccessPolicy;
  appName?: string;
  resourceName: string;
}

/** Path of the RFC 9728 metadata document for a resource; the first one is also at the root. */
export function resourceMetadataPath(settings: AuthSettings, resource: string): string {
  if (resource === settings.resources[0]) return '/.well-known/oauth-protected-resource';
  return `/.well-known/oauth-protected-resource${new URL(resource).pathname}`;
}

function sendRedirect(res: Response, status: 302 | 303, redirect: ClientRedirect): void {
  const url = new URL(redirect.redirectUri);
  for (const [name, value] of Object.entries(redirect.params)) url.searchParams.set(name, value);
  res.setHeader('Cache-Control', 'no-store');
  res.redirect(status, url.toString());
}

function loginRedirect(res: Response, originalUrl: string): void {
  res.setHeader('Cache-Control', 'no-store');
  res.redirect(302, `/oauth/login?return_to=${encodeURIComponent(originalUrl)}`);
}

function failurePage(res: Response, outcome: Exclude<DeviceOutcome, { kind: 'success' }>): void {
  switch (outcome.kind) {
    case 'not_allowed':
      sendErrorPage(res, 403, 'Account not allowed', `The GitHub account ${outcome.login} is not allowed to use this whiteboard.`, '/oauth/login');
      return;
    case 'expired':
      sendErrorPage(res, 400, 'Code expired', 'The sign-in code expired before it was entered on GitHub.', '/oauth/login');
      return;
    case 'denied':
      sendErrorPage(res, 400, 'Sign-in cancelled', 'The sign-in was cancelled on GitHub.', '/oauth/login');
      return;
    case 'error':
      sendErrorPage(res, 502, 'Sign-in failed', 'GitHub could not confirm the sign-in. Try again.', '/oauth/login');
  }
}

/** Metadata documents (RFC 9728, RFC 8414) and every `/oauth/*` endpoint. */
export function createOAuthRouter(deps: OAuthRouterDeps): express.Router {
  const { settings, cookies, sessions, clients, deviceSignIn, authorization, tokens } = deps;
  const issuer = settings.issuer;
  const router = express.Router();
  const urlencoded = express.urlencoded({ extended: false, limit: '16kb' });
  const json = express.json({ limit: '16kb' });

  const loginLimiter = rateLimit({ windowMs: 60_000, max: 20, name: 'login' });
  // Each start asks GitHub for a device code.
  const deviceStartLimiter = rateLimit({ windowMs: 60_000, max: 5, name: 'sign-in' });
  const devicePollLimiter = rateLimit({ windowMs: 60_000, max: 60, name: 'sign-in status' });
  const tokenLimiter = rateLimit({ windowMs: 60_000, max: 60, name: 'token' });
  const registerLimiter = rateLimit({ windowMs: 60_000, max: 10, name: 'registration' });
  // Authorization requests can make the server fetch a client metadata document.
  const authorizeLimiter = rateLimit({ windowMs: 60_000, max: 60, name: 'authorization' });

  // ---- Metadata ----
  for (const resource of settings.resources) {
    const document = (_req: Request, res: Response): void => {
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.json({
        resource,
        authorization_servers: [issuer],
        scopes_supported: [WHITEBOARD_SCOPE],
        bearer_methods_supported: ['header'],
        resource_name: deps.resourceName
      });
    };
    const path = resourceMetadataPath(settings, resource);
    router.get(path, document);
    const byPath = `/.well-known/oauth-protected-resource${new URL(resource).pathname}`;
    if (byPath !== path) router.get(byPath, document);
  }
  // Resources that come and go (one per board): `/.well-known/oauth-protected-resource/b/<id>/mcp`.
  router.get(/^\/\.well-known\/oauth-protected-resource(\/[A-Za-z0-9/_-]+)$/, (req, res) => {
    const resource = `${issuer}${(req.params as Record<string, string>)[0]}`;
    if (!deps.policy.describeResource(resource)) {
      res.setHeader('Cache-Control', 'no-store');
      res.status(404).json({ error: 'not_found', error_description: 'no such protected resource' });
      return;
    }
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.json({
      resource,
      authorization_servers: [issuer],
      scopes_supported: [WHITEBOARD_SCOPE],
      bearer_methods_supported: ['header'],
      resource_name: `${deps.resourceName}: ${deps.policy.describeResource(resource)!.name}`
    });
  });

  router.get('/.well-known/oauth-authorization-server', (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json({
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      registration_endpoint: `${issuer}/oauth/register`,
      scopes_supported: [WHITEBOARD_SCOPE],
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
      authorization_response_iss_parameter_supported: true,
      client_id_metadata_document_supported: true
    });
  });

  // ---- Dynamic Client Registration (RFC 7591) ----
  router.post('/oauth/register', registerLimiter, json, (req, res) => {
    try {
      const registration = clients.register(req.body);
      res.setHeader('Cache-Control', 'no-store');
      res.status(201).json(registration);
    } catch (error) {
      if (error instanceof ClientError) return oauthError(res, 400, error.code, error.message);
      throw error;
    }
  });

  // ---- GitHub sign-in (device flow) ----
  router.get('/oauth/login', loginLimiter, (req, res) => {
    sendLoginPage(res, safeReturnPath(single(req.query.return_to)));
  });

  router.post('/oauth/login', deviceStartLimiter, urlencoded, async (req, res, next) => {
    try {
      if (!isSameOrigin(req.headers, issuer)) return sendErrorPage(res, 403, 'Forbidden', 'Cross-site request rejected.');
      const started = await deviceSignIn.start(single(req.body?.return_to));
      if (started.kind === 'too_many') {
        res.setHeader('Retry-After', '60');
        return sendErrorPage(res, 503, 'Too many sign-ins', 'Too many sign-ins are waiting for GitHub right now. Try again in a few minutes.', '/oauth/login');
      }
      if (started.kind === 'unavailable') {
        return sendErrorPage(res, 502, 'Sign-in unavailable', 'GitHub did not start the sign-in. Check that Device Flow is enabled for the OAuth app, then try again.', '/oauth/login');
      }
      cookies.set(res, cookies.device, started.binding, started.lifetimeSeconds, 'Strict');
      res.setHeader('Cache-Control', 'no-store');
      res.redirect(303, '/oauth/device');
    } catch (error) {
      next(error);
    }
  });

  router.get('/oauth/device', loginLimiter, (req, res) => {
    const view = deviceSignIn.view(cookies.read(req.headers.cookie, cookies.device));
    if (view.kind === 'none') {
      cookies.clear(res, cookies.device, 'Strict');
      return sendErrorPage(res, 400, 'No sign-in in progress', 'This sign-in expired or was not started in this browser.', '/oauth/login');
    }
    if (view.kind === 'failed') {
      cookies.clear(res, cookies.device, 'Strict');
      return failurePage(res, view.outcome);
    }
    sendDevicePage(res, {
      userCode: view.userCode,
      verificationUri: view.verificationUri,
      ...(deps.appName ? { appName: deps.appName } : {}),
      intervalSeconds: view.intervalSeconds,
      expiresAt: view.expiresAt
    });
  });

  router.get('/oauth/device.js', (_req, res) => sendDeviceScript(res));

  router.post('/oauth/device/poll', devicePollLimiter, async (req, res, next) => {
    try {
      const wantsHtml = req.accepts(['json', 'html']) === 'html';
      res.setHeader('Cache-Control', 'no-store');
      if (!isSameOrigin(req.headers, issuer)) {
        res.status(403).json({ status: 'forbidden', error: 'Cross-site request rejected' });
        return;
      }
      const result = await deviceSignIn.poll(cookies.read(req.headers.cookie, cookies.device));
      if (result.kind === 'none') {
        if (wantsHtml) return res.redirect(303, '/oauth/device');
        res.status(400).json({ status: 'unknown', error: 'No sign-in in progress in this browser' });
        return;
      }
      if (result.kind === 'complete') {
        cookies.clear(res, cookies.device, 'Strict');
        const session = sessions.issue(result.login);
        cookies.set(res, cookies.session, session.value, session.maxAgeSeconds);
        if (wantsHtml) return res.redirect(303, result.returnTo);
        res.json({ status: 'complete', redirect: result.returnTo });
        return;
      }
      if (wantsHtml) return res.redirect(303, '/oauth/device');
      if (result.kind === 'failed') {
        res.json({ status: 'failed', reason: result.reason });
        return;
      }
      res.json({ status: 'pending', interval: result.intervalSeconds });
    } catch (error) {
      next(error);
    }
  });

  // ---- Authorization endpoint ----
  router.get('/oauth/authorize', authorizeLimiter, async (req, res, next) => {
    try {
      const result = await authorization.begin({
        clientId: req.query.client_id,
        redirectUri: single(req.query.redirect_uri),
        responseType: single(req.query.response_type),
        codeChallenge: single(req.query.code_challenge),
        codeChallengeMethod: single(req.query.code_challenge_method),
        scope: single(req.query.scope),
        resource: req.query.resource,
        state: single(req.query.state)
      }, cookies.read(req.headers.cookie, cookies.session));
      switch (result.kind) {
        case 'error_page': return sendErrorPage(res, result.status, result.title, result.message);
        case 'redirect': return sendRedirect(res, 302, result);
        case 'login': return loginRedirect(res, req.originalUrl);
        case 'consent': return sendConsentPage(res, result.view);
      }
    } catch (error) {
      next(error);
    }
  });

  router.post('/oauth/authorize', urlencoded, async (req, res, next) => {
    try {
      if (!isSameOrigin(req.headers, issuer)) return sendErrorPage(res, 403, 'Forbidden', 'Cross-site request rejected.');
      const result = await authorization.decide(single(req.body?.ticket), single(req.body?.decision), cookies.read(req.headers.cookie, cookies.session));
      if (result.kind === 'error_page') return sendErrorPage(res, result.status, result.title, result.message);
      sendRedirect(res, 303, result);
    } catch (error) {
      next(error);
    }
  });

  // ---- Token endpoint ----
  router.post('/oauth/token', tokenLimiter, urlencoded, async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      let clientId = single(body.client_id);
      let clientSecret = single(body.client_secret);
      let usedBasic = false;
      const basic = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(req.headers.authorization ?? '');
      if (basic) {
        if (clientSecret !== undefined) return oauthError(res, 400, 'invalid_request', 'use one client authentication method');
        const decoded = Buffer.from(basic[1]!, 'base64').toString('utf8');
        const colon = decoded.indexOf(':');
        const challenge = { 'WWW-Authenticate': 'Basic' };
        if (colon < 0) return oauthError(res, 401, 'invalid_client', 'malformed Basic credentials', challenge);
        let basicId: string;
        try {
          basicId = decodeURIComponent(decoded.slice(0, colon));
          clientSecret = decodeURIComponent(decoded.slice(colon + 1));
        } catch {
          return oauthError(res, 401, 'invalid_client', 'malformed Basic credentials', challenge);
        }
        if (clientId !== undefined && clientId !== basicId) return oauthError(res, 400, 'invalid_request', 'client_id mismatch');
        clientId = basicId;
        usedBasic = true;
      }
      const result = await tokens.exchange({ clientId, clientSecret, usedBasic }, {
        grantType: single(body.grant_type),
        code: single(body.code),
        redirectUri: single(body.redirect_uri),
        codeVerifier: single(body.code_verifier),
        refreshToken: single(body.refresh_token),
        scope: single(body.scope),
        resource: body.resource
      });
      if (!result.ok) return oauthError(res, result.status, result.error, result.description, result.basicChallenge ? { 'WWW-Authenticate': 'Basic' } : {});
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Pragma', 'no-cache');
      res.json(result.body);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
