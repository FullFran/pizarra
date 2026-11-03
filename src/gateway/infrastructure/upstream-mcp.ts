import type { McpServerFactory } from '@modelcontextprotocol/server';

/**
 * Loads upstream's MCP server factory with its tools pointed at the
 * internal canvas. Upstream reads `EXPRESS_SERVER_URL` once, when its config
 * module is first imported, so the variable is set before the import, and
 * auto-starting a second canvas is disabled.
 */
export async function loadUpstreamMcpFactory(canvasUrl: string, options: { exportDir?: string } = {}): Promise<McpServerFactory> {
  process.env.EXPRESS_SERVER_URL = canvasUrl;
  // Upstream's MCP file tools read and write only below this directory
  // (its default is the process's working directory, i.e. the app itself).
  if (options.exportDir) process.env.EXCALIDRAW_EXPORT_DIR = options.exportDir;
  process.env.EXCALIDRAW_NO_AUTOSTART = '1';
  const config = await import('mcp-excalidraw-server/dist/core/config.js');
  if (options.exportDir && config.ALLOWED_EXPORT_DIR !== options.exportDir) {
    throw new Error(`upstream MCP file tools would use ${config.ALLOWED_EXPORT_DIR}, not ${options.exportDir}`);
  }
  if (config.EXPRESS_SERVER_URL !== canvasUrl) {
    throw new Error(`upstream MCP tools would reach ${config.EXPRESS_SERVER_URL}, not ${canvasUrl}: it was imported too early`);
  }
  const module = await import('mcp-excalidraw-server/dist/core/mcp-server.js');
  return module.excalidrawMcpServerFactory;
}
