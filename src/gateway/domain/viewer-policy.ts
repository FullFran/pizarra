/**
 * Upstream MCP tools a viewer may call: they only read the board. Every
 * other tool (create, update, delete, import, snapshot, viewport, export to
 * a file or to excalidraw.com) is refused for viewers. A tool upstream adds
 * later is refused until it is listed here.
 */
export const VIEWER_TOOLS: ReadonlySet<string> = new Set([
  'describe_scene',
  'get_canvas_screenshot',
  'get_element',
  'get_resource',
  'query_elements',
  'read_diagram_guide'
]);

/**
 * The tools a JSON-RPC body (one message or a batch) calls that a viewer may
 * not; an empty list means the body is allowed. Unparseable bodies are left
 * to the MCP handler (which rejects them without calling a tool).
 */
export function toolsRefusedToViewer(body: unknown): string[] {
  const messages = Array.isArray(body) ? body : [body];
  const refused: string[] = [];
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const { method, params } = message as { method?: unknown; params?: { name?: unknown } };
    if (method !== 'tools/call') continue;
    const name = typeof params?.name === 'string' ? params.name : '';
    if (!VIEWER_TOOLS.has(name)) refused.push(name || '(unnamed)');
  }
  return refused;
}
