/**
 * What the agent's engine may do on `/mcp`: call the tools it was given, and nothing else.
 * `tools/list` is not filtered here (the engine restricts itself to its list and the gateway
 * refuses a call outside it). Like the viewer's filter it fails closed: the body is decoded the
 * way the MCP handler will decode it, and anything unreadable is refused.
 */

/** The tools a JSON-RPC body (one message or a batch) calls that `allowed` does not list. */
export function toolsRefusedToAgent(body: unknown, allowed: ReadonlySet<string>): string[] {
  const messages = Array.isArray(body) ? body : [body];
  const refused: string[] = [];
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const { method, params } = message as { method?: unknown; params?: { name?: unknown } };
    if (method !== 'tools/call') continue;
    const name = typeof params?.name === 'string' ? params.name : '';
    if (!allowed.has(name)) refused.push(name || '(unnamed)');
  }
  return refused;
}

export type AgentVerdict = { ok: true } | { ok: false; status: 400 | 403 | 415; message: string };

export function agentRequestVerdict(
  body: Uint8Array | undefined,
  headers: { contentEncoding?: string | undefined; contentType?: string | undefined; mcpMethod?: string | undefined; mcpName?: string | undefined },
  allowed: ReadonlySet<string>
): AgentVerdict {
  const encoding = headers.contentEncoding?.trim().toLowerCase();
  if (encoding && encoding !== 'identity') return { ok: false, status: 415, message: 'The agent may not send encoded request bodies' };
  const charset = /;\s*charset\s*=\s*"?([^";\s]+)/i.exec(headers.contentType ?? '')?.[1]?.toLowerCase();
  if (charset && charset !== 'utf-8' && charset !== 'utf8') return { ok: false, status: 415, message: 'The agent may only send UTF-8 request bodies' };
  if (headers.mcpMethod?.trim() === 'tools/call' && !allowed.has(headers.mcpName?.trim() ?? '')) {
    return { ok: false, status: 403, message: `The agent may not call ${headers.mcpName?.trim() || '(unnamed)'}` };
  }
  if (!body || body.length === 0) return { ok: true };
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch {
    return { ok: false, status: 400, message: 'The request body could not be read' };
  }
  const messages = Array.isArray(parsed) ? parsed : [parsed];
  if (messages.length === 0 || messages.some(message => !message || typeof message !== 'object' || Array.isArray(message))) {
    return { ok: false, status: 400, message: 'The request body could not be read' };
  }
  const refused = toolsRefusedToAgent(parsed, allowed);
  if (refused.length > 0) return { ok: false, status: 403, message: `The agent may not call ${refused.join(', ')}` };
  return { ok: true };
}
