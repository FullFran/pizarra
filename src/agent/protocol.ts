/**
 * The line-delimited JSON protocol between the gateway and one agent engine process.
 *
 * The engine is a separate program (`engine/main.mjs`) running the pi agent for one person on
 * one board. The gateway writes one JSON object per line to its stdin and reads one per line
 * from its stdout. Everything the child sends is untrusted: it is parsed against the shapes
 * below, unknown fields are dropped, and free text from the model only travels in `delta` and
 * `thinking`, which the browser renders as text, never as markup.
 *
 * Adapted from RE;write's engine protocol (fullfran/re-write, src/adapters/engine-protocol.ts).
 */

/** The only error texts that may reach a browser or a log. */
export const ENGINE_ERROR_CODES = [
  'model_busy', 'reconnect', 'provider_error', 'busy', 'turn_in_progress',
  'not_connected', 'engine_unavailable', 'login_failed', 'rate_limited', 'turn_limit', 'model_unavailable'
] as const;
export type EngineErrorCode = typeof ENGINE_ERROR_CODES[number];

export function toErrorCode(value: unknown, fallback: EngineErrorCode = 'provider_error'): EngineErrorCode {
  return (ENGINE_ERROR_CODES as readonly unknown[]).includes(value) ? value as EngineErrorCode : fallback;
}

/** Where a person types the device code. Fixed here, never taken from the child. */
export const DEVICE_VERIFICATION_URI = 'https://auth.openai.com/codex/device';
/** Name the engine registers Pizarra's MCP server under; tools are `mcp__pizarra__<tool>`. */
export const MCP_SERVER_NAME = 'pizarra';
export const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

/**
 * The board tools the agent may call. The gateway enforces this list on `/mcp` for engine
 * tokens; the engine also refuses to start if its MCP server offers a tool outside it.
 * Left out on purpose: `clear_canvas`, `import_scene`, `restore_snapshot` (bulk destructive),
 * `export_*` (writes files or publishes a scene), `set_viewport` (moves everyone's view).
 */
export const AGENT_TOOLS = [
  'create_element', 'batch_create_elements', 'update_element', 'delete_element',
  'get_element', 'query_elements', 'describe_scene', 'read_diagram_guide', 'get_canvas_screenshot',
  'create_from_mermaid', 'group_elements', 'ungroup_elements', 'align_elements', 'distribute_elements',
  'duplicate_elements', 'snapshot_scene', 'get_resource'
] as const;

/** Tools whose streamed arguments become draft previews on the board. */
export const DRAFT_TOOLS = ['create_element', 'batch_create_elements'] as const;

export const MAX_LINE_BYTES = 1_048_576;
const MAX_DELTA_CHARS = 65_536;
const MAX_SECRET_CHARS = 16_384;

/** A person's ChatGPT credential. The refresh token is single-use and rotates. */
export interface StoredCredential {
  access: string;
  refresh: string;
  expires: number;
  accountId: string;
}

const isSecret = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= MAX_SECRET_CHARS;

export function parseCredential(value: unknown): StoredCredential | null {
  const c = value as Partial<StoredCredential> | null;
  if (typeof c !== 'object' || c === null) return null;
  if (!isSecret(c.access) || !isSecret(c.refresh) || !isSecret(c.accountId)) return null;
  if (typeof c.expires !== 'number' || !Number.isFinite(c.expires) || c.expires <= 0) return null;
  return { access: c.access, refresh: c.refresh, expires: c.expires, accountId: c.accountId };
}

/** A model id as the provider names it. Strict, so an id is never text. */
export const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

/** Pi's thinking levels, lowest first. A model supports some of them; pi clamps the rest. */
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ThinkingLevel = typeof THINKING_LEVELS[number];
export const isThinkingLevel = (value: unknown): value is ThinkingLevel => (THINKING_LEVELS as readonly unknown[]).includes(value);

/** One model of the person's account, as the panel offers it. */
export interface ModelInfo {
  id: string;
  /** The provider's display name; the id when the name is not plain text. */
  name: string;
  /** The thinking levels this model supports, lowest first; `['off']` without reasoning. */
  levels: ThinkingLevel[];
}

const MODEL_NAME = /^[\x20-\x7E]{1,64}$/;
const MAX_MODELS = 64;

function parseModelInfo(value: unknown): ModelInfo | null {
  const m = value as Record<string, unknown> | null;
  if (typeof m !== 'object' || m === null || typeof m.id !== 'string' || !MODEL_ID.test(m.id)) return null;
  if (!Array.isArray(m.levels) || m.levels.length === 0 || !m.levels.every(isThinkingLevel)) return null;
  const levels = THINKING_LEVELS.filter(level => (m.levels as unknown[]).includes(level));
  return { id: m.id, name: typeof m.name === 'string' && MODEL_NAME.test(m.name) ? m.name : m.id, levels };
}

/**
 * One shape the agent is drawing, as the browser previews it before the tool runs. Only plain
 * drawing properties survive: no ids, bindings, links, files or custom data.
 */
export interface DraftElement {
  type: typeof DRAFT_TYPES[number];
  x: number;
  y: number;
  width?: number;
  height?: number;
  strokeColor?: string;
  backgroundColor?: string;
  strokeWidth?: number;
  strokeStyle?: 'solid' | 'dashed' | 'dotted';
  roughness?: number;
  opacity?: number;
  text?: string;
  fontSize?: number;
  fontFamily?: number;
  startArrowhead?: string | null;
  endArrowhead?: string | null;
}

export const DRAFT_TYPES = ['rectangle', 'ellipse', 'diamond', 'arrow', 'line', 'text'] as const;
export const MAX_DRAFT_ELEMENTS = 200;
const MAX_COORD = 1_000_000;
const MAX_TEXT = 2_000;
const COLOR = /^(#[0-9A-Fa-f]{3,8}|[a-z]{3,20}|transparent)$/;
const ARROWHEADS = ['arrow', 'bar', 'dot', 'triangle', 'circle', 'diamond'];

const coord = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= MAX_COORD ? value : undefined;
const inRange = (value: unknown, min: number, max: number): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : undefined;

/** One draft element from untrusted input, or null when it is not a drawable shape yet. */
export function parseDraftElement(value: unknown): DraftElement | null {
  const e = value as Record<string, unknown> | null;
  if (typeof e !== 'object' || e === null || Array.isArray(e)) return null;
  if (!(DRAFT_TYPES as readonly unknown[]).includes(e.type)) return null;
  const x = coord(e.x);
  const y = coord(e.y);
  if (x === undefined || y === undefined) return null;
  const out: DraftElement = { type: e.type as DraftElement['type'], x, y };
  const width = inRange(e.width, 0, MAX_COORD);
  const height = inRange(e.height, 0, MAX_COORD);
  if (width !== undefined) out.width = width;
  if (height !== undefined) out.height = height;
  if (typeof e.strokeColor === 'string' && COLOR.test(e.strokeColor)) out.strokeColor = e.strokeColor;
  if (typeof e.backgroundColor === 'string' && COLOR.test(e.backgroundColor)) out.backgroundColor = e.backgroundColor;
  const strokeWidth = inRange(e.strokeWidth, 0, 100);
  if (strokeWidth !== undefined) out.strokeWidth = strokeWidth;
  if (e.strokeStyle === 'solid' || e.strokeStyle === 'dashed' || e.strokeStyle === 'dotted') out.strokeStyle = e.strokeStyle;
  const roughness = inRange(e.roughness, 0, 10);
  if (roughness !== undefined) out.roughness = roughness;
  const opacity = inRange(e.opacity, 0, 100);
  if (opacity !== undefined) out.opacity = opacity;
  if (typeof e.text === 'string') out.text = e.text.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, ch => (ch === '\n' ? ch : '')).slice(0, MAX_TEXT);
  const fontSize = inRange(e.fontSize, 1, 500);
  if (fontSize !== undefined) out.fontSize = fontSize;
  const fontFamily = inRange(e.fontFamily, 1, 10);
  if (fontFamily !== undefined && Number.isInteger(fontFamily)) out.fontFamily = fontFamily;
  for (const key of ['startArrowhead', 'endArrowhead'] as const) {
    if (e[key] === null) out[key] = null;
    else if (typeof e[key] === 'string' && ARROWHEADS.includes(e[key] as string)) out[key] = e[key] as string;
  }
  return out;
}

export type ParentMessage =
  /**
   * `mcpUrl` is this board's loopback MCP endpoint and `mcpToken` a short-lived engine token
   * for this person and board. `allowedModels`: the operator's allowlist, if any.
   */
  | { type: 'start'; mcpUrl: string; mcpToken: string; systemPrompt: string; allowedModels?: string[] }
  | { type: 'login.start' }
  | { type: 'login.cancel' }
  | { type: 'refresh'; id: string; credential: StoredCredential }
  | { type: 'token'; id: string; access?: string; accountId?: string; expires?: number; error?: EngineErrorCode }
  | { type: 'prompt'; text: string; model?: string; thinking?: ThinkingLevel }
  /** Lists the account's models (allowlist applied); answered by `models` or `models.failed`. */
  | { type: 'models' }
  | { type: 'reset' }
  | { type: 'abort' }
  | { type: 'shutdown' };

/** One step of a tool call. Never carries arguments or results as text. */
export interface ToolMessage {
  type: 'tool';
  /** Pairs start and end, and the drafts of this call. */
  call: number;
  name: string;
  phase: 'start' | 'end';
  ok: boolean;
}

/**
 * The shapes a tool call has streamed so far, complete objects only, in order. Each message
 * replaces the previous draft of the same call. The tool's end (`tool` phase `end` with the
 * same `call`) retires the draft: the real elements arrive through the board's own WebSocket.
 */
export interface DraftMessage {
  type: 'draft';
  call: number;
  elements: DraftElement[];
}

export type ChildMessage =
  | { type: 'ready'; piVersion: string }
  | { type: 'login.code'; userCode: string }
  | { type: 'login.done'; credential: StoredCredential }
  | { type: 'login.failed' }
  | { type: 'refresh.done'; id: string; credential: StoredCredential }
  | { type: 'refresh.failed'; id: string }
  | { type: 'token.get'; id: string }
  | { type: 'session'; tools: string[] }
  | { type: 'delta'; text: string }
  | { type: 'thinking'; text: string }
  | ToolMessage
  | DraftMessage
  | { type: 'done'; aborted: boolean }
  | { type: 'error'; code: EngineErrorCode }
  | { type: 'reset.done' }
  | { type: 'models'; models: ModelInfo[] }
  | { type: 'models.failed'; code: EngineErrorCode }
  /** The model and thinking level a turn actually runs with, after the allowlist and clamping. */
  | { type: 'settings'; model: string; thinking: ThinkingLevel };

export function encode(message: ParentMessage | ChildMessage): string {
  return `${JSON.stringify(message)}\n`;
}

const ID = /^[A-Za-z0-9-]{1,64}$/;
const USER_CODE = /^[A-Z0-9][A-Z0-9-]{2,18}[A-Z0-9]$/;
const VERSION = /^[0-9A-Za-z.+-]{1,32}$/;
const TOOL_NAME = /^[A-Za-z0-9_]{1,128}$/;
const MAX_CALL = 100_000;
const isCall = (value: unknown): value is number => Number.isInteger(value) && (value as number) > 0 && (value as number) <= MAX_CALL;

/** Accepts only known messages with well-formed fields; anything else is `null`. */
export function parseChildMessage(value: unknown): ChildMessage | null {
  const m = value as Record<string, unknown> | null;
  if (typeof m !== 'object' || m === null || Array.isArray(m)) return null;
  const id = typeof m.id === 'string' && ID.test(m.id) ? m.id : null;
  switch (m.type) {
    case 'ready':
      return { type: 'ready', piVersion: typeof m.piVersion === 'string' && VERSION.test(m.piVersion) ? m.piVersion : 'unknown' };
    case 'login.code':
      return typeof m.userCode === 'string' && USER_CODE.test(m.userCode) ? { type: 'login.code', userCode: m.userCode } : null;
    case 'login.done': {
      const credential = parseCredential(m.credential);
      return credential ? { type: 'login.done', credential } : null;
    }
    case 'login.failed':
      return { type: 'login.failed' };
    case 'refresh.done': {
      const credential = parseCredential(m.credential);
      return id && credential ? { type: 'refresh.done', id, credential } : null;
    }
    case 'refresh.failed':
      return id ? { type: 'refresh.failed', id } : null;
    case 'token.get':
      return id ? { type: 'token.get', id } : null;
    case 'session':
      return Array.isArray(m.tools) && m.tools.length <= 256 && m.tools.every(t => typeof t === 'string' && TOOL_NAME.test(t))
        ? { type: 'session', tools: m.tools as string[] } : null;
    case 'delta':
    case 'thinking':
      return typeof m.text === 'string' && m.text.length <= MAX_DELTA_CHARS ? { type: m.type, text: m.text } : null;
    case 'tool':
      if (!isCall(m.call) || typeof m.name !== 'string' || !TOOL_NAME.test(m.name)) return null;
      return { type: 'tool', call: m.call, name: m.name, phase: m.phase === 'start' ? 'start' : 'end', ok: m.phase === 'start' || m.ok === true };
    case 'draft': {
      if (!isCall(m.call) || !Array.isArray(m.elements) || m.elements.length > MAX_DRAFT_ELEMENTS) return null;
      const elements = m.elements.map(parseDraftElement).filter((e): e is DraftElement => e !== null);
      return { type: 'draft', call: m.call, elements };
    }
    case 'done':
      return { type: 'done', aborted: m.aborted === true };
    case 'error':
      return { type: 'error', code: toErrorCode(m.code) };
    case 'reset.done':
      return { type: 'reset.done' };
    case 'models': {
      if (!Array.isArray(m.models) || m.models.length > MAX_MODELS) return null;
      const models = m.models.map(parseModelInfo);
      return models.every((model): model is ModelInfo => model !== null) ? { type: 'models', models } : null;
    }
    case 'models.failed':
      return { type: 'models.failed', code: toErrorCode(m.code, 'engine_unavailable') };
    case 'settings':
      return typeof m.model === 'string' && MODEL_ID.test(m.model) && isThinkingLevel(m.thinking)
        ? { type: 'settings', model: m.model, thinking: m.thinking } : null;
    default:
      return null;
  }
}

/** Splits a byte stream into JSON lines. A line over the limit is a protocol violation. */
export class LineDecoder {
  private buffer = '';

  /** Returns the parsed lines; a line that is not JSON yields `undefined` in its place. */
  push(chunk: Buffer | string): unknown[] {
    this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    const out: unknown[] = [];
    let index: number;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { out.push(undefined); }
    }
    if (this.buffer.length > MAX_LINE_BYTES) {
      this.buffer = '';
      throw new Error('engine protocol line too long');
    }
    return out;
  }
}
