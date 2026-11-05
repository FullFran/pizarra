import { mkdirSync } from 'node:fs';
import { createRequire, register } from 'node:module';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { McpServerFactory } from '@modelcontextprotocol/server';

const require = createRequire(import.meta.url);
const CONFIG_ENTRY = pathToFileURL(require.resolve('mcp-excalidraw-server/dist/core/config.js')).href;
const SERVER_ENTRY = pathToFileURL(require.resolve('mcp-excalidraw-server/dist/core/mcp-server.js')).href;
/** Only upstream's own compiled modules are instantiated per board. */
const SCOPE = `${pathToFileURL(dirname(dirname(require.resolve('mcp-excalidraw-server/dist/core/config.js')))).href}/`;

let hooksRegistered = false;

function registerHooks(): void {
  if (hooksRegistered) return;
  register(new URL('./board-module-hooks.js', import.meta.url), { data: { scope: SCOPE } });
  hooksRegistered = true;
}

export interface BoardMcpOptions {
  /** Base URL of the canvas pool; board `<id>` is at `<base>/b/<id>`. */
  canvasBaseUrl: string;
  /** Directory upstream's MCP file tools may use for a board. */
  exportDirOf: (board: string) => string;
}

/**
 * Upstream's MCP server factory, one instance per board. Upstream reads
 * `EXPRESS_SERVER_URL` and `EXCALIDRAW_EXPORT_DIR` once, when its config
 * module is first imported, and keeps scene state at module level; so each
 * board imports its own copy of upstream's modules (see
 * board-module-hooks.ts), with the variables set just before, one board at
 * a time. A board's tools reach only `<pool>/b/<id>` and write only below
 * its export directory. Instances are kept for the life of the process
 * (ES modules cannot be unloaded): a few MB per board that ever used MCP.
 */
export class BoardMcpFactories {
  private readonly factories = new Map<string, Promise<McpServerFactory>>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: BoardMcpOptions) {
    registerHooks();
    // Upstream's tools must never start a second canvas of their own.
    process.env.EXCALIDRAW_NO_AUTOSTART = '1';
  }

  get(board: string): Promise<McpServerFactory> {
    let factory = this.factories.get(board);
    if (!factory) {
      factory = this.queue.then(() => this.load(board));
      this.queue = factory.catch(() => undefined);
      factory.catch(() => this.factories.delete(board));
      this.factories.set(board, factory);
    }
    return factory;
  }

  private async load(board: string): Promise<McpServerFactory> {
    const canvasUrl = `${this.options.canvasBaseUrl}/b/${board}`;
    const exportDir = this.options.exportDirOf(board);
    mkdirSync(exportDir, { recursive: true, mode: 0o700 });
    const query = `?pizarra-board=${encodeURIComponent(board)}`;
    process.env.EXPRESS_SERVER_URL = canvasUrl;
    process.env.EXCALIDRAW_EXPORT_DIR = exportDir;
    try {
      const config = await import(`${CONFIG_ENTRY}${query}`) as { EXPRESS_SERVER_URL: string; ALLOWED_EXPORT_DIR: string };
      if (config.EXPRESS_SERVER_URL !== canvasUrl) throw new Error(`board ${board}: upstream MCP tools would reach ${config.EXPRESS_SERVER_URL}, not ${canvasUrl}`);
      if (config.ALLOWED_EXPORT_DIR !== exportDir) throw new Error(`board ${board}: upstream MCP file tools would use ${config.ALLOWED_EXPORT_DIR}, not ${exportDir}`);
      const module = await import(`${SERVER_ENTRY}${query}`) as { excalidrawMcpServerFactory: McpServerFactory };
      return module.excalidrawMcpServerFactory;
    } finally {
      delete process.env.EXPRESS_SERVER_URL;
      delete process.env.EXCALIDRAW_EXPORT_DIR;
    }
  }
}
