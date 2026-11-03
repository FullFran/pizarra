import { join, resolve } from 'node:path';
import { parsePublicBaseUrl, parseTrustProxy } from './shared/network.js';

export interface GatewayConfig {
  host: string;
  port: number;
  publicBaseUrl?: string;
  trustProxy: boolean | number | string;
  /** Internal port of the upstream canvas on 127.0.0.1; 0 picks a free one. */
  canvasPort: number;
  /** Durable canvas state (upstream's EXCALIDRAW_DATA_DIR): CANVAS_DATA_DIR, else `$EXCALIDRAW_DATA_DIR/canvas`. */
  canvasDataDir?: string;
  /** Where upstream's MCP file tools may read and write: EXCALIDRAW_EXPORT_DIR, else `$EXCALIDRAW_DATA_DIR/files`. */
  exportDir?: string;
}

function readPort(name: string, raw: string | undefined, fallback: number): number {
  const value = raw?.trim();
  if (!value) return fallback;
  if (!/^\d+$/.test(value) || Number(value) > 65535) throw new Error(`${name} must be a port number, got ${JSON.stringify(value)}`);
  return Number(value);
}

/** Gateway settings from the environment (auth has its own, in `auth/`). */
export function resolveGatewayConfig(env: Record<string, string | undefined>): GatewayConfig {
  const publicBaseUrl = parsePublicBaseUrl(env.PUBLIC_BASE_URL);
  const port = readPort('PORT', env.PORT, 3000);
  const canvasPort = readPort('CANVAS_INTERNAL_PORT', env.CANVAS_INTERNAL_PORT, 0);
  if (canvasPort !== 0 && canvasPort === port) throw new Error('CANVAS_INTERNAL_PORT must differ from PORT');
  const dataDir = env.EXCALIDRAW_DATA_DIR?.trim();
  const canvasDataDir = env.CANVAS_DATA_DIR?.trim() || (dataDir ? join(dataDir, 'canvas') : undefined);
  const exportDir = env.EXCALIDRAW_EXPORT_DIR?.trim() || (dataDir ? join(dataDir, 'files') : undefined);
  return {
    host: env.HOST?.trim() || '127.0.0.1',
    port,
    ...(publicBaseUrl ? { publicBaseUrl } : {}),
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    canvasPort,
    ...(canvasDataDir ? { canvasDataDir: resolve(canvasDataDir) } : {}),
    ...(exportDir ? { exportDir: resolve(exportDir) } : {})
  };
}
