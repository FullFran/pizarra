const VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;
const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** Only S256 is accepted (OAuth 2.1). */
export const PKCE_METHOD = 'S256';

export function isValidCodeChallenge(challenge: string): boolean {
  return CHALLENGE_PATTERN.test(challenge);
}

export function isValidCodeVerifier(verifier: string): boolean {
  return VERIFIER_PATTERN.test(verifier);
}

/**
 * RFC 7636 S256: BASE64URL(SHA256(ASCII(code_verifier))) == code_challenge.
 * The hash and the comparison are supplied by the caller (no crypto here).
 */
export function pkceS256Matches(
  verifier: string,
  challenge: string,
  sha256Base64Url: (value: string) => string,
  equal: (a: string, b: string) => boolean
): boolean {
  if (!isValidCodeVerifier(verifier)) return false;
  return equal(sha256Base64Url(verifier), challenge);
}
