/** Minimal structured logger (one JSON line per entry on stderr). */
export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

export function createLogger(levelName: string | undefined = process.env.LOG_LEVEL, sink: (line: string) => void = line => process.stderr.write(`${line}\n`)): Logger {
  const threshold = LEVELS[(levelName?.toLowerCase() as Level) ?? 'info'] ?? LEVELS.info;
  const emit = (level: Level) => (message: string, fields?: Record<string, unknown>) => {
    if (LEVELS[level] < threshold) return;
    sink(JSON.stringify({ time: new Date().toISOString(), level, message, ...(fields ?? {}) }));
  };
  return { debug: emit('debug'), info: emit('info'), warn: emit('warn'), error: emit('error') };
}
