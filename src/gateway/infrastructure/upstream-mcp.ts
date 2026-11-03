import type { McpServerFactory } from '@modelcontextprotocol/server';

/**
 * Loads upstream's MCP server factory with its tools pointed at the
 * internal canvas. Upstream reads `EXPRESS_SERVER_URL` once, when its config
 * module is first imported, so the variable is set before the import, and
 * auto-starting a second canvas is disabled.
 */
export async function loadUpstreamMcpFactory(canvasUrl: string): Promise<McpServerFactory> {
  process.env.EXPRESS_SERVER_URL = canvasUrl;
  process.env.EXCALIDRAW_NO_AUTOSTART = '1';
  const config = await import('mcp-excalidraw-server/dist/core/config.js');
  if (config.EXPRESS_SERVER_URL !== canvasUrl) {
    throw new Error(`upstream MCP tools would reach ${config.EXPRESS_SERVER_URL}, not ${canvasUrl}: it was imported too early`);
  }
  const module = await import('mcp-excalidraw-server/dist/core/mcp-server.js');
  return module.excalidrawMcpServerFactory;
}
