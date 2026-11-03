const GITHUB_LOGIN_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38})$/i;

export class InvalidLoginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidLoginError';
  }
}

/** GitHub logins allowed to sign in, compared case-insensitively. */
export class Allowlist {
  private readonly logins: ReadonlySet<string>;

  constructor(logins: Iterable<string>) {
    this.logins = new Set([...logins].map(login => login.toLowerCase()));
  }

  /** Parses a comma-separated list; throws on a malformed login or an empty list. */
  static parse(raw: string): Allowlist {
    const logins: string[] = [];
    for (const entry of raw.split(',')) {
      const login = entry.trim();
      if (!login) continue;
      if (!GITHUB_LOGIN_PATTERN.test(login)) {
        throw new InvalidLoginError(`ALLOWED_GITHUB_LOGINS contains an invalid GitHub login: ${JSON.stringify(login)}.`);
      }
      logins.push(login);
    }
    if (logins.length === 0) throw new InvalidLoginError('ALLOWED_GITHUB_LOGINS must list at least one GitHub login.');
    return new Allowlist(logins);
  }

  has(login: string): boolean {
    return this.logins.has(login.toLowerCase());
  }

  get size(): number {
    return this.logins.size;
  }
}
