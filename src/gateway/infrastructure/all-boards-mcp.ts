import { McpServer, fromJsonSchema } from '@modelcontextprotocol/server';
import type { McpServerFactory } from '@modelcontextprotocol/server';
import { VIEWER_TOOLS } from '../domain/viewer-policy.js';
import type { BoardSummary } from '../application/ports.js';
import type { BoardToolkit, UpstreamTool, UpstreamToolResult } from './upstream-mcp.js';

export const LIST_BOARDS_TOOL = 'list_boards';

export interface AllBoardsMcpDeps {
  /** The boards this caller can open (GitHub boards only), with their role. */
  list: () => BoardSummary[];
  /** This caller's role on one board, or undefined when it cannot open it. */
  roleOn: (board: string) => BoardSummary['role'] | undefined;
  /** The board's own copy of upstream's tools. */
  toolkit: (board: string) => Promise<BoardToolkit>;
  /** The tool list every board shares (upstream's, read from board main's copy). */
  tools: readonly UpstreamTool[];
}

/** registerTool with upstream's own result shape (upstream registers its tools the same way). */
type Register = (name: string, config: { description?: string; inputSchema: ReturnType<typeof fromJsonSchema> }, cb: (args: unknown) => Promise<UpstreamToolResult>) => unknown;

const failure = (text: string): UpstreamToolResult => ({ content: [{ type: 'text', text }], isError: true });

/** Upstream's input schema plus a required `board` argument. */
export function withBoardArgument(schema: Record<string, unknown>): Record<string, unknown> {
  const properties = (schema.properties && typeof schema.properties === 'object' ? schema.properties : {}) as Record<string, unknown>;
  const required = Array.isArray(schema.required) ? schema.required.filter(name => name !== 'board') : [];
  return {
    ...schema,
    type: 'object',
    properties: { board: { type: 'string', description: `Id of the board to work on (see ${LIST_BOARDS_TOOL}).` }, ...properties },
    required: ['board', ...required],
  };
}

/**
 * One MCP server over every board its caller can open: `list_boards`, then
 * each of upstream's tools with a required `board` argument, dispatched to
 * that board's own copy of upstream (the same one `/b/<id>/mcp` uses). Each
 * call checks the caller's role on the named board then: a board it cannot
 * open answers as if it did not exist, and viewers may call only the
 * read-only tools. Built per request, for one caller.
 */
export function allBoardsMcpFactory(deps: AllBoardsMcpDeps): McpServerFactory {
  return () => {
    const server = new McpServer(
      { name: 'pizarra-boards', version: '1.0.0', description: 'Every pizarra board you can open: list them, then work on one by passing its id as `board`.' },
      { capabilities: { tools: {} } },
    );
    const register = server.registerTool.bind(server) as unknown as Register;
    register(LIST_BOARDS_TOOL, {
      description: 'List the boards you can open, with your role on each (owner, editor or viewer). Pass a board id as `board` to the other tools; viewers may only read.',
      inputSchema: fromJsonSchema({ type: 'object', properties: {} }),
    }, async () => {
      const boards = deps.list().map(({ id, name, role }) => ({ id, name, role }));
      return { content: [{ type: 'text', text: JSON.stringify({ boards }, null, 2) }] };
    });
    for (const tool of deps.tools) {
      if (tool.name === LIST_BOARDS_TOOL) continue;
      register(tool.name, {
        ...(tool.description !== undefined ? { description: tool.description } : {}),
        inputSchema: fromJsonSchema(withBoardArgument(tool.inputSchema) as Parameters<typeof fromJsonSchema>[0]),
      }, async (args: unknown) => {
        const { board, ...rest } = (args ?? {}) as Record<string, unknown>;
        if (typeof board !== 'string') return failure('`board` is required: the id of a board from list_boards.');
        const role = deps.roleOn(board);
        if (!role) return failure(`Board not found: ${board}. Call ${LIST_BOARDS_TOOL} for the boards you can open.`);
        if (role === 'viewer' && !VIEWER_TOOLS.has(tool.name)) return failure(`You can only view board ${board}; ${tool.name} is not allowed there.`);
        const toolkit = await deps.toolkit(board);
        return toolkit.call(tool.name, rest);
      });
    }
    return server;
  };
}
