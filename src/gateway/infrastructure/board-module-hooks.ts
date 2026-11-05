/**
 * Module resolution hook (registered with `node:module` `register`): an
 * import from an upstream module whose URL carries `?pizarra-board=<id>`
 * resolves the upstream modules it imports with the same query. Each board
 * thereby gets its own instance of upstream's MCP modules, with its own
 * `EXPRESS_SERVER_URL` and `EXCALIDRAW_EXPORT_DIR` (module constants read at
 * import), without changing upstream. Third-party packages stay shared.
 */
let scope = '';

export function initialize(data: { scope: string }): void {
  scope = data.scope;
}

interface ResolveResult { url: string; format?: string | null | undefined; shortCircuit?: boolean | undefined }
type NextResolve = (specifier: string, context: { parentURL?: string | undefined }) => Promise<ResolveResult>;

export async function resolve(specifier: string, context: { parentURL?: string | undefined }, nextResolve: NextResolve): Promise<ResolveResult> {
  const result = await nextResolve(specifier, context);
  const parent = context.parentURL;
  if (!scope || !parent || !parent.startsWith(scope) || !result.url.startsWith(scope) || result.url.includes('?')) return result;
  const board = new URL(parent).searchParams.get('pizarra-board');
  if (!board) return result;
  return { ...result, url: `${result.url}?pizarra-board=${encodeURIComponent(board)}` };
}
