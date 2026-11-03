import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { isAllowedRedirectUri, redirectUriMatches } from '../../dist/auth/domain/redirect-uri.js';
import { safeReturnPath } from '../../dist/auth/domain/return-path.js';
import { isValidCodeChallenge, pkceS256Matches } from '../../dist/auth/domain/pkce.js';
import { chooseResource } from '../../dist/auth/domain/resource.js';
import { withinGrant, requestedScopes, onlyKnownScopes } from '../../dist/auth/domain/scope.js';
import { Allowlist } from '../../dist/auth/domain/allowlist.js';
import { FixedWindowLimiter } from '../../dist/auth/domain/rate-limit.js';
import { clientFromMetadataDocument, isCimdClientId, metadataCacheSeconds, parseRegistration } from '../../dist/auth/domain/client.js';
import { intervalAfterSlowDown, deviceLoginLifetimeSeconds } from '../../dist/auth/domain/device-login.js';
import { isApiPath, isPlainPath, isSafeMethod, isSameOrigin } from '../../dist/gateway/domain/request-policy.js';

test('redirect URIs: https and http loopback only, no fragment or credentials', () => {
  for (const uri of ['https://chatgpt.com/connector_platform_oauth_redirect', 'http://127.0.0.1:43123/cb', 'http://localhost/cb', 'http://[::1]:9/cb']) {
    assert.equal(isAllowedRedirectUri(uri), true, uri);
  }
  for (const uri of ['myapp://cb', 'http://evil.example/cb', 'https://x.example/cb#f', 'https://u:p@x.example/cb', '', 42, `https://x.example/${'a'.repeat(2000)}`]) {
    assert.equal(isAllowedRedirectUri(uri), false, String(uri).slice(0, 40));
  }
});

test('redirect URI matching: exact, except the loopback port (RFC 8252)', () => {
  const registered = ['http://127.0.0.1/cb', 'https://app.example/cb'];
  assert.equal(redirectUriMatches(registered, 'https://app.example/cb'), true);
  assert.equal(redirectUriMatches(registered, 'http://127.0.0.1:51234/cb'), true);
  assert.equal(redirectUriMatches(registered, 'http://127.0.0.1:51234/other'), false);
  assert.equal(redirectUriMatches(registered, 'http://localhost:51234/cb'), false);
  assert.equal(redirectUriMatches(registered, 'https://app.example/cb?x=1'), false);
  assert.equal(redirectUriMatches(registered, 'https://app.example:8443/cb'), false);
});

test('return path: same-origin only; tab, newline, CR, backslash and protocol-relative fall back to "/"', () => {
  for (const value of ['/\t/evil.example', '/\n/evil.example', '/\r/evil.example', '/\\evil.example', '/\t\\evil.example', '//evil.example', 'https://evil.example', 'evil', '', undefined, `/${'a'.repeat(5000)}`]) {
    assert.equal(safeReturnPath(value), '/', JSON.stringify(value));
  }
  assert.equal(safeReturnPath('/oauth/authorize?client_id=x&state=y'), '/oauth/authorize?client_id=x&state=y');
  assert.equal(safeReturnPath('/%09/evil.example'), '/%09/evil.example');
  assert.equal(new URL(safeReturnPath('/%09/evil.example'), 'https://board.example').origin, 'https://board.example');
});

test('PKCE: S256 only, verifier syntax enforced', () => {
  const verifier = 'v'.repeat(43);
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const hash = v => createHash('sha256').update(v, 'ascii').digest('base64url');
  const eq = (a, b) => a === b;
  assert.equal(isValidCodeChallenge(challenge), true);
  assert.equal(isValidCodeChallenge('short'), false);
  assert.equal(pkceS256Matches(verifier, challenge, hash, eq), true);
  assert.equal(pkceS256Matches('w'.repeat(43), challenge, hash, eq), false);
  assert.equal(pkceS256Matches('short', hash('short'), hash, eq), false, 'verifier shorter than 43 chars');
  assert.equal(pkceS256Matches(`${'v'.repeat(42)} `, hash(`${'v'.repeat(42)} `), hash, eq), false, 'verifier with a space');
});

test('resource (RFC 8707): one of the configured audiences; default only when there is exactly one', () => {
  const one = ['https://b.example/mcp'];
  assert.deepEqual(chooseResource(undefined, one), { ok: true, resource: one[0] });
  assert.deepEqual(chooseResource('https://b.example/mcp', one), { ok: true, resource: one[0] });
  assert.equal(chooseResource('https://other.example/mcp', one).ok, false);
  assert.equal(chooseResource(['https://b.example/mcp', 'https://b.example/mcp'], one).ok, false);
  const two = ['https://b.example/mcp', 'https://b.example/x'];
  assert.equal(chooseResource(undefined, two).ok, false);
  assert.deepEqual(chooseResource('https://b.example/x', two), { ok: true, resource: two[1] });
});

test('scopes and allowlist', () => {
  assert.deepEqual(requestedScopes(undefined), ['whiteboard']);
  assert.equal(onlyKnownScopes(requestedScopes('whiteboard admin')), false);
  assert.equal(withinGrant('whiteboard', 'whiteboard'), true);
  assert.equal(withinGrant('admin', 'whiteboard'), false);
  const list = Allowlist.parse(' FullFran, someone-else ');
  assert.equal(list.has('fullfran'), true);
  assert.equal(list.has('mallory'), false);
  assert.throws(() => Allowlist.parse('bad login!'), /invalid GitHub login/);
  assert.throws(() => Allowlist.parse(' , '), /at least one/);
});

test('rate limit: fixed window per key', () => {
  const limiter = new FixedWindowLimiter(60_000, 2);
  assert.equal(limiter.hit('a', 0), 0);
  assert.equal(limiter.hit('a', 1), 0);
  assert.equal(limiter.hit('a', 2), 60);
  assert.equal(limiter.hit('b', 2), 0);
  assert.equal(limiter.hit('a', 60_001), 0);
});

test('client metadata: CIMD id shape, document validation, cache bounds, DCR body', () => {
  assert.equal(isCimdClientId('https://app.example/client.json'), true);
  assert.equal(isCimdClientId('https://app.example'), false);
  assert.equal(isCimdClientId('http://app.example/client.json'), false);
  const id = 'https://app.example/client.json';
  const client = clientFromMetadataDocument(id, JSON.stringify({ client_id: id, client_name: 'A', redirect_uris: ['https://app.example/cb'] }));
  assert.equal(client.kind, 'cimd');
  assert.throws(() => clientFromMetadataDocument(id, JSON.stringify({ client_id: 'https://x.example/c', redirect_uris: ['https://app.example/cb'] })), /does not match/);
  assert.throws(() => clientFromMetadataDocument(id, JSON.stringify({ client_id: id, redirect_uris: ['https://a/cb'], token_endpoint_auth_method: 'client_secret_post' })), /public clients/);
  assert.throws(() => clientFromMetadataDocument(id, '[]'), /JSON object/);
  assert.equal(metadataCacheSeconds('max-age=5'), 60);
  assert.equal(metadataCacheSeconds('max-age=999999'), 86400);
  assert.equal(metadataCacheSeconds(undefined), 300);
  assert.equal(metadataCacheSeconds('no-store'), 60);
  assert.throws(() => parseRegistration({ redirect_uris: ['myapp://cb'] }), /not allowed/);
  assert.equal(parseRegistration({ redirect_uris: ['https://a.example/cb'] }).authMethod, 'none');
});

test('device login timing rules', () => {
  assert.equal(intervalAfterSlowDown(5000, undefined), 10000);
  assert.equal(intervalAfterSlowDown(5000, 20), 20000);
  assert.equal(deviceLoginLifetimeSeconds(3600), 900);
});

test('CSRF path classification is case-insensitive; same-origin uses Origin, then Referer', () => {
  for (const path of ['/api', '/api/elements', '/API/elements', '/Api/elements/clear', '/aPi/x']) assert.equal(isApiPath(path), true, path);
  for (const path of ['/', '/apix', '/assets/api/x', '/%61pi/elements']) assert.equal(isApiPath(path), false, path);
  assert.equal(isSafeMethod('get'), true);
  assert.equal(isSafeMethod('POST'), false);
  const origin = 'https://board.example';
  assert.equal(isSameOrigin(origin, origin, undefined), true);
  assert.equal(isSameOrigin(origin, 'https://evil.example', `${origin}/x`), false, 'Origin wins over Referer');
  assert.equal(isSameOrigin(origin, 'null', undefined), false);
  assert.equal(isSameOrigin(origin, undefined, `${origin}/page`), true);
  assert.equal(isSameOrigin(origin, undefined, 'not a url'), false);
  assert.equal(isSameOrigin(origin, undefined, undefined), false);
});

test('proxied paths must be plain', () => {
  for (const path of ['/', '/api/elements', '/assets/index-abc.js', '/api/elements/a.b']) assert.equal(isPlainPath(path), true, path);
  for (const path of ['/api/../health', '/./x', '/a/%2e%2e/b', '/a%2Fb', '/a\\b', '/a%5cb', '/a%00', 'x']) assert.equal(isPlainPath(path), false, path);
});

// ChatGPT's CIMD document prefers private_key_jwt but also lists "none" in
// token_endpoint_auth_methods_supported; we only support public clients, so a
// document that offers "none" must be accepted as a public client.
test('CIMD: a document offering "none" among several methods is a public client', () => {
  const id = 'https://chatgpt.com/oauth/abc/client.json';
  const doc = {
    client_id: id,
    client_name: 'ChatGPT',
    redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
    token_endpoint_auth_method: 'private_key_jwt',
    token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'],
    jwks_uri: 'https://chatgpt.com/oauth/jwks.json'
  };
  const client = clientFromMetadataDocument(id, JSON.stringify(doc));
  assert.equal(client.authMethod, 'none');
  assert.deepEqual(client.redirectUris, ['https://chatgpt.com/connector_platform_oauth_redirect']);
});

test('CIMD: a document that only allows confidential methods is still refused', () => {
  const id = 'https://app.example/client.json';
  const base = { client_id: id, redirect_uris: ['https://app.example/cb'] };
  for (const extra of [
    { token_endpoint_auth_method: 'private_key_jwt' },
    { token_endpoint_auth_method: 'private_key_jwt', token_endpoint_auth_methods_supported: ['private_key_jwt'] },
    { token_endpoint_auth_methods_supported: ['client_secret_basic'] },
    { token_endpoint_auth_methods_supported: 'none' }
  ]) {
    assert.throws(() => clientFromMetadataDocument(id, JSON.stringify({ ...base, ...extra })), /public clients/, JSON.stringify(extra));
  }
  // The plain public case keeps working.
  assert.equal(clientFromMetadataDocument(id, JSON.stringify(base)).authMethod, 'none');
});
