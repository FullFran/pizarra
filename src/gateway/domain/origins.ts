const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Hostnames that name this machine. */
export function isLoopbackOrigin(hostname: string): boolean {
  return LOOPBACK.has(hostname);
}
