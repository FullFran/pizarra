/** A GitHub login: letters, digits and single hyphens inside, at most 39 characters. */
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/** `PIZARRA_AGENT_USERS`: the GitHub logins that may use the agent. Case-insensitive, like GitHub. */
export class AgentAllowlist {
  private readonly logins: ReadonlySet<string>;

  private constructor(logins: Set<string>) {
    this.logins = logins;
  }

  /** Throws (naming the variable) on an empty list or an entry that is not a GitHub login. */
  static parse(raw: string | undefined): AgentAllowlist {
    const entries = (raw ?? '').split(',').map(entry => entry.trim()).filter(Boolean);
    if (entries.length === 0) throw new Error('PIZARRA_AGENT_USERS must list at least one GitHub login (comma separated)');
    const logins = new Set<string>();
    for (const entry of entries) {
      if (!LOGIN.test(entry)) throw new Error(`PIZARRA_AGENT_USERS has an entry that is not a GitHub login: ${JSON.stringify(entry)}`);
      logins.add(entry.toLowerCase());
    }
    return new AgentAllowlist(logins);
  }

  has(login: string): boolean {
    return this.logins.has(login.toLowerCase());
  }

  get size(): number {
    return this.logins.size;
  }
}
