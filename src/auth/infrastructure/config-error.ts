export class AuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthConfigError';
  }
}

export type Env = Record<string, string | undefined>;

/** `NAME` or `NAME_FILE` (never both); undefined when neither is set. */
export function readSecretVariable(env: Env, name: string, readFile: (path: string) => string): string | undefined {
  const direct = env[name]?.trim();
  const filePath = env[`${name}_FILE`]?.trim();
  if (direct && filePath) throw new AuthConfigError(`Set only one of ${name} and ${name}_FILE.`);
  if (direct) return direct;
  if (filePath) {
    let value: string;
    try {
      value = readFile(filePath).trim();
    } catch (error) {
      throw new AuthConfigError(`Cannot read ${name}_FILE (${filePath}): ${(error as Error).message}`);
    }
    if (value) return value;
    throw new AuthConfigError(`${name}_FILE (${filePath}) is empty.`);
  }
  return undefined;
}

export function readTtl(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) throw new AuthConfigError(`${name} must be a whole number of seconds, got ${JSON.stringify(raw)}.`);
  const value = Number(raw);
  if (value < min || value > max) throw new AuthConfigError(`${name} must be between ${min} and ${max}, got ${value}.`);
  return value;
}
