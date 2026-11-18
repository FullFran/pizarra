/**
 * Draft extraction: turns the arguments of a tool call that is still streaming into the shapes
 * the board previews before the tool runs. Pure and free of pi imports, so it is unit-tested
 * without a model. The contract is `src/agent/protocol.ts` (compiled to `dist/agent/protocol.js`).
 */
import { DRAFT_TOOLS, MAX_DRAFT_ELEMENTS, MCP_TOOL_PREFIX, parseDraftElement } from '../dist/agent/protocol.js';

/** The tool's own name without the `mcp__pizarra__` prefix pi adds. */
export function baseToolName(name) {
  return typeof name === 'string' && name.startsWith(MCP_TOOL_PREFIX) ? name.slice(MCP_TOOL_PREFIX.length) : String(name ?? '');
}

/**
 * The complete shapes a call has streamed so far.
 * `batch_create_elements`: every element of `arguments.elements`, except the last one while the
 * call still streams (it may be cut off mid-object). `create_element`: the shape once complete.
 * Any other tool, and any invalid shape, gives nothing.
 */
export function draftElements(tool, args, complete) {
  if (!DRAFT_TOOLS.includes(tool)) return [];
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return [];
  let candidates;
  if (tool === 'batch_create_elements') {
    const list = args.elements;
    if (!Array.isArray(list)) return [];
    candidates = complete ? list : list.slice(0, -1);
  } else {
    if (!complete) return [];
    candidates = [args];
  }
  const out = [];
  for (const candidate of candidates.slice(0, MAX_DRAFT_ELEMENTS)) {
    const element = parseDraftElement(candidate);
    if (element) out.push(element);
  }
  return out;
}

/**
 * Sends a call's draft only when it changed, at most once per `interval` ms per call. A change
 * that arrives too early is held and sent when the interval is over (trailing edge); `final`
 * sends the last list at once.
 */
export function createDraftThrottle({ send, interval = 100, now = Date.now, schedule = setTimeout, cancel = clearTimeout }) {
  const calls = new Map();
  const stateOf = (call) => {
    let state = calls.get(call);
    if (!state) { state = { sentKey: '[]', sentAt: -Infinity, latest: [], timer: undefined }; calls.set(call, state); }
    return state;
  };
  const flush = (call, state) => {
    if (state.timer !== undefined) { cancel(state.timer); state.timer = undefined; }
    const key = JSON.stringify(state.latest);
    if (key === state.sentKey) return;
    state.sentKey = key;
    state.sentAt = now();
    send({ type: 'draft', call, elements: state.latest });
  };
  return {
    update(call, elements) {
      const state = stateOf(call);
      state.latest = elements;
      if (JSON.stringify(elements) === state.sentKey) return;
      const wait = state.sentAt + interval - now();
      if (wait <= 0) return flush(call, state);
      state.timer ??= schedule(() => { state.timer = undefined; flush(call, state); }, wait);
    },
    final(call, elements) {
      const state = stateOf(call);
      state.latest = elements;
      flush(call, state);
    },
    drop(call) {
      const state = calls.get(call);
      if (state?.timer !== undefined) cancel(state.timer);
      calls.delete(call);
    },
    clear() {
      for (const call of [...calls.keys()]) this.drop(call);
    },
  };
}
