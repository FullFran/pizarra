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
  /**
   * PIZARRA_ROLE: `gateway` (default) serves the app; `canvas` only runs the
   * upstream canvas, for gateways elsewhere that point CANVAS_URL at it.
   */
  role: 'gateway' | 'canvas';
  /** CANVAS_URL: a canvas run by another process (`http://host:port`); the gateway then spawns none. */
  canvasUrl?: URL;
  /** CANVAS_BIND_HOST: where the canvas role's upstream listens (default 0.0.0.0, it serves other containers). */
  canvasBindHost: string;
}

function readCanvasUrl(raw: string | undefined): URL | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`CANVAS_URL must be an http URL like http://pizarra-canvas:3100, got ${JSON.stringify(value)}`);
  }
  if (url.protocol !== 'http:' || !url.port || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash || url.username || url.password) {
    throw new Error(`CANVAS_URL must be http://host:port with nothing after the port, got ${JSON.stringify(value)}`);
  }
  return url;
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
  const roleRaw = env.PIZARRA_ROLE?.trim() || 'gateway';
  if (roleRaw !== 'gateway' && roleRaw !== 'canvas') throw new Error(`PIZARRA_ROLE must be gateway or canvas, got ${JSON.stringify(roleRaw)}`);
  const role = roleRaw;
  const canvasUrl = readCanvasUrl(env.CANVAS_URL);
  if (role === 'canvas' && canvasUrl) throw new Error('CANVAS_URL is for gateways; PIZARRA_ROLE=canvas runs the canvas itself');
  if (role === 'canvas' && canvasPort === 0) throw new Error('PIZARRA_ROLE=canvas needs CANVAS_INTERNAL_PORT (the port gateways reach it on)');
  return {
    role,
    ...(canvasUrl ? { canvasUrl } : {}),
    canvasBindHost: env.CANVAS_BIND_HOST?.trim() || '0.0.0.0',
    host: env.HOST?.trim() || '127.0.0.1',
    port,
    ...(publicBaseUrl ? { publicBaseUrl } : {}),
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    canvasPort,
    ...(canvasDataDir ? { canvasDataDir: resolve(canvasDataDir) } : {}),
    ...(exportDir ? { exportDir: resolve(exportDir) } : {})
  };
}
