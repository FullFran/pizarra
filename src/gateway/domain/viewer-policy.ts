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

export type ViewerVerdict = { ok: true } | { ok: false; status: 400 | 403 | 415; message: string };

/**
 * Whether a viewer's MCP request may reach the MCP handler. Fails closed:
 * the body is decoded exactly as the handler will (UTF-8, a leading BOM
 * stripped), and anything that cannot be read with certainty (another
 * charset or content encoding, invalid UTF-8 or JSON, a message that is not
 * an object) is refused instead of passed on. The `mcp-method`/`mcp-name`
 * headers of 2026-07-28 requests are checked too.
 */
export function viewerRequestVerdict(body: Uint8Array | undefined, headers: { contentEncoding?: string | undefined; contentType?: string | undefined; mcpMethod?: string | undefined; mcpName?: string | undefined }): ViewerVerdict {
  const encoding = headers.contentEncoding?.trim().toLowerCase();
  if (encoding && encoding !== 'identity') return { ok: false, status: 415, message: 'This board is read-only for you: encoded request bodies are not accepted' };
  const charset = /;\s*charset\s*=\s*"?([^";\s]+)/i.exec(headers.contentType ?? '')?.[1]?.toLowerCase();
  if (charset && charset !== 'utf-8' && charset !== 'utf8') return { ok: false, status: 415, message: 'This board is read-only for you: only UTF-8 request bodies are accepted' };
  if (headers.mcpMethod?.trim() === 'tools/call' && !VIEWER_TOOLS.has(headers.mcpName?.trim() ?? '')) {
    return { ok: false, status: 403, message: `This board is read-only for you: ${headers.mcpName?.trim() || '(unnamed)'} not allowed` };
  }
  if (!body || body.length === 0) return { ok: true };
  let parsed: unknown;
  try {
    // WHATWG UTF-8 decode, as the MCP handler's Request.json(): a leading BOM is dropped.
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch {
    return { ok: false, status: 400, message: 'This board is read-only for you: the request body could not be read' };
  }
  const messages = Array.isArray(parsed) ? parsed : [parsed];
  if (messages.length === 0 || messages.some(message => !message || typeof message !== 'object' || Array.isArray(message))) {
    return { ok: false, status: 400, message: 'This board is read-only for you: the request body could not be read' };
  }
  const refused = toolsRefusedToViewer(parsed);
  if (refused.length > 0) return { ok: false, status: 403, message: `This board is read-only for you: ${refused.join(', ')} not allowed` };
  return { ok: true };
}
