import { mkdirSync } from 'node:fs';
import { createRequire, register } from 'node:module';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { McpServerFactory } from '@modelcontextprotocol/server';

const require = createRequire(import.meta.url);
const CONFIG_ENTRY = pathToFileURL(require.resolve('mcp-excalidraw-server/dist/core/config.js')).href;
const SERVER_ENTRY = pathToFileURL(require.resolve('mcp-excalidraw-server/dist/core/mcp-server.js')).href;
const TOOLS_ENTRY = pathToFileURL(require.resolve('mcp-excalidraw-server/dist/core/mcp-tools.js')).href;
const DISPATCH_ENTRY = pathToFileURL(require.resolve('mcp-excalidraw-server/dist/core/mcp-dispatch.js')).href;
/** Only upstream's own compiled modules are instantiated per board. */
const SCOPE = `${pathToFileURL(dirname(dirname(require.resolve('mcp-excalidraw-server/dist/core/config.js')))).href}/`;

let hooksRegistered = false;

function registerHooks(): void {
  if (hooksRegistered) return;
  register(new URL('./board-module-hooks.js', import.meta.url), { data: { scope: SCOPE } });
  hooksRegistered = true;
}

/** One of upstream's MCP tools: its name, description and JSON Schema input. */
export interface UpstreamTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

/** A tool result as upstream returns it (MCP `CallToolResult`). */
export type UpstreamToolResult = { content: unknown[]; isError?: boolean } & Record<string, unknown>;

/** A board's own copy of upstream's tools, callable in-process. */
export interface BoardToolkit {
  tools: readonly UpstreamTool[];
  call(name: string, args: Record<string, unknown>): Promise<UpstreamToolResult>;
}

interface BoardMcp {
  factory: McpServerFactory;
  toolkit: BoardToolkit;
}

/**
 * Opens a board's canvas in the pool before an in-process call. Upstream's
 * tools give a canvas only 500 ms to answer /health, less than a closed
 * board takes to start; the pool opens it on this first request.
 */
async function openCanvas(canvasUrl: string): Promise<void> {
  try {
    const response = await fetch(`${canvasUrl}/health`, { signal: AbortSignal.timeout(20_000) });
    await response.body?.cancel();
  } catch {
    // Upstream's own check then reports the canvas as unreachable.
  }
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
  private readonly boards = new Map<string, Promise<BoardMcp>>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: BoardMcpOptions) {
    registerHooks();
    // Upstream's tools must never start a second canvas of their own.
    process.env.EXCALIDRAW_NO_AUTOSTART = '1';
  }

  async get(board: string): Promise<McpServerFactory> {
    return (await this.instance(board)).factory;
  }

  /** The same board instance's tools, for callers that dispatch in-process (the all-boards MCP). */
  async toolkit(board: string): Promise<BoardToolkit> {
    return (await this.instance(board)).toolkit;
  }

  private instance(board: string): Promise<BoardMcp> {
    let instance = this.boards.get(board);
    if (!instance) {
      instance = this.queue.then(() => this.load(board));
      this.queue = instance.catch(() => undefined);
      instance.catch(() => this.boards.delete(board));
      this.boards.set(board, instance);
    }
    return instance;
  }

  private async load(board: string): Promise<BoardMcp> {
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
      // The same query resolves to the very modules the server above imported (board-module-hooks.ts).
      const { tools } = await import(`${TOOLS_ENTRY}${query}`) as { tools: UpstreamTool[] };
      const dispatch = await import(`${DISPATCH_ENTRY}${query}`) as { callExcalidrawTool: (name: string, args: Record<string, unknown>) => Promise<UpstreamToolResult> };
      return {
        factory: module.excalidrawMcpServerFactory,
        toolkit: {
          tools,
          call: async (name, args) => {
            await openCanvas(canvasUrl);
            return dispatch.callExcalidrawTool(name, args);
          },
        },
      };
    } finally {
      delete process.env.EXPRESS_SERVER_URL;
      delete process.env.EXCALIDRAW_EXPORT_DIR;
    }
  }
}
