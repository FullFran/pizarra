// Claims of a trusted issuer's board ticket (docs/auth.md, issue #12).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkTicketClaims } from '../../dist/auth/domain/signed-ticket.js';

const now = 1_800_000_000;
const expected = { issuer: 'https://app.hagalink.es', audience: 'https://pizarra.hagalink.es', now };
const good = { iss: expected.issuer, aud: expected.audience, sub: 'u-1', name: 'Ana', board: 'p1', role: 'viewer', jti: 'j1', iat: now, exp: now + 300 };

test('a well-formed ticket passes and keeps only the claims pizarra uses', () => {
  const checked = checkTicketClaims({ ...good, extra: 'ignored' }, expected);
  assert.deepEqual(checked, { ok: true, claims: { iss: good.iss, sub: 'u-1', name: 'Ana', board: 'p1', role: 'viewer', jti: 'j1', exp: now + 300 } });
  assert.equal(checkTicketClaims({ ...good, aud: ['x', expected.audience] }, expected).ok, true, 'aud may be an array');
  assert.equal(checkTicketClaims({ ...good, name: undefined }, expected).ok, true, 'name is optional');
});

test('every broken rule is refused with its reason', () => {
  const cases = [
    [{ iss: 'https://other' }, 'wrong issuer'],
    [{ aud: 'https://elsewhere' }, 'wrong audience'],
    [{ exp: now }, 'expired'],
    [{ exp: now + 3600, iat: undefined }, 'lives longer than five minutes'],
    [{ iat: now - 10, exp: now + 295 }, 'lives longer than five minutes'],
    [{ iat: now + 600 }, 'issued in the future'],
    [{ nbf: now + 600 }, 'not valid yet'],
    [{ sub: '' }, 'no subject'],
    [{ board: 'Bad/Board' }, 'bad board'],
    [{ role: 'owner' }, 'bad role'],
    [{ jti: undefined }, 'no jti'],
    [{ exp: 'soon' }, 'no expiry']
  ];
  for (const [change, reason] of cases) assert.deepEqual(checkTicketClaims({ ...good, ...change }, expected), { ok: false, reason }, reason);
});
