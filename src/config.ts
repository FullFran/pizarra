import { resolve } from 'node:path';
import { parsePublicBaseUrl, parseTrustProxy } from './shared/network.js';
import { parseFrameAncestors } from './gateway/domain/framing.js';

export interface GatewayConfig {
  host: string;
  port: number;
  publicBaseUrl?: string;
  trustProxy: boolean | number | string;
  /** Internal port of the upstream canvas on 127.0.0.1; 0 picks a free one. */
  canvasPort: number;
  /** EXCALIDRAW_DATA_DIR: boards.json, the auth files, and `boards/<id>/{canvas,files}` for every board. */
  dataDir?: string;
  /** CANVAS_DATA_DIR: board main's canvas directory instead of `$EXCALIDRAW_DATA_DIR/boards/main/canvas`. */
  canvasDataDir?: string;
  /** EXCALIDRAW_EXPORT_DIR: board main's export directory instead of `$EXCALIDRAW_DATA_DIR/boards/main/files`. */
  exportDir?: string;
  /** BOARD_IDLE_SECONDS: a board's canvas stops after this long without use (main never does). */
  boardIdleSeconds: number;
  /** MAX_OPEN_BOARDS: at most this many canvases run at once, main included. */
  maxOpenBoards: number;
  /** FRAME_ANCESTORS: origins allowed to frame board pages (none: nothing is framed). */
  frameAncestors: string[];
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

function readCount(name: string, raw: string | undefined, fallback: number, min: number, max: number): number {
  const value = raw?.trim();
  if (!value) return fallback;
  if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max) throw new Error(`${name} must be a whole number from ${min} to ${max}, got ${JSON.stringify(value)}`);
  return Number(value);
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
  const canvasDataDir = env.CANVAS_DATA_DIR?.trim() || undefined;
  const exportDir = env.EXCALIDRAW_EXPORT_DIR?.trim() || undefined;
  const boardIdleSeconds = readCount('BOARD_IDLE_SECONDS', env.BOARD_IDLE_SECONDS, 600, 1, 7 * 86400);
  const maxOpenBoards = readCount('MAX_OPEN_BOARDS', env.MAX_OPEN_BOARDS, 8, 1, 1000);
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
    boardIdleSeconds,
    maxOpenBoards,
    frameAncestors: parseFrameAncestors(env.FRAME_ANCESTORS),
    ...(dataDir ? { dataDir: resolve(dataDir) } : {}),
    ...(canvasDataDir ? { canvasDataDir: resolve(canvasDataDir) } : {}),
    ...(exportDir ? { exportDir: resolve(exportDir) } : {})
  };
}
