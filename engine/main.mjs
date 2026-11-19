/**
 * The agent engine process: one person, one board, one conversation, on the pi SDK.
 *
 * The gateway starts this program and talks to it over stdin and stdout with the protocol of
 * `src/agent/protocol.ts` (compiled to `dist/agent/protocol.js`). It gets no credential on its
 * command line or in its environment: it asks the gateway for the current access token when
 * the model runtime needs one, and the gateway alone holds the refresh token. It has no shell
 * and no file tools; its only tools are the board's MCP tools, reached on loopback with a
 * short-lived engine token and restricted to `AGENT_TOOLS`.
 *
 * Ported from RE;write's embedded engine (fullfran/re-write, engine/main.ts) and training-mcp's.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import {
  createAgentSession, createMcpExtension, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, VERSION,
} from '@earendil-works/pi-coding-agent';
import {
  AGENT_TOOLS, DEVICE_VERIFICATION_URI, DRAFT_TOOLS, encode, LineDecoder, MCP_SERVER_NAME, MCP_TOOL_PREFIX,
  MODEL_ID, parseCredential, toErrorCode,
} from '../dist/agent/protocol.js';
import { baseToolName, createDraftThrottle, draftElements } from './draft.mjs';

const PROVIDER = 'openai-codex';
/** Pi asks for five minutes of validity; the gateway hands out at least ten. */
const TOKEN_REUSE_MARGIN_MS = 6 * 60_000;
const MCP_CONNECT_WAIT_MS = 15_000;
const MAX_PROMPT_CHARS = 20_000;
const MAX_SYSTEM_PROMPT_CHARS = 50_000;
const MAX_SECRET_CHARS = 16_384;
const ID = /^[A-Za-z0-9-]{1,64}$/;
const ALLOWED_TOOLS = new Set(AGENT_TOOLS.map((tool) => MCP_TOOL_PREFIX + tool));

// stdout carries the protocol and nothing else.
const writeLine = process.stdout.write.bind(process.stdout);
process.stdout.write = () => true;
console.log = console.info = console.debug = console.warn = console.error = () => {};
const send = (message) => { writeLine(encode(message)); };

// A private home: nothing of this process reads or writes the operator's pi files.
const home = mkdtempSync(join(tmpdir(), 'pizarra-engine-'));
const agentDir = join(home, 'agent');
const cwd = join(home, 'work');
mkdirSync(agentDir);
mkdirSync(cwd);
process.env.HOME = home;
process.env.PI_CODING_AGENT_DIR = agentDir;
process.on('exit', () => rmSync(home, { recursive: true, force: true }));

class Reconnect extends Error {}
/** The operator's allowlist leaves no model of this account. */
class NoAllowedModel extends Error {}

/** Maps anything thrown or reported by the SDK to a fixed code. The text never leaves. */
function codeOf(error) {
  if (error instanceof Reconnect) return 'reconnect';
  if (error instanceof NoAllowedModel) return 'model_unavailable';
  const text = error instanceof Error ? error.message : String(error ?? '');
  if (/\b(429|503|529)\b|overloaded|rate.?limit|capacity|too many requests/i.test(text)) return 'model_busy';
  if (/\b(401|403)\b|unauthori[sz]ed|invalid.?(token|grant)|token.*(expired|revoked)|sign in again|reconnect/i.test(text)) return 'reconnect';
  return 'provider_error';
}

// --- Access token, held by the gateway ---------------------------------------------------

const tokenWaiters = new Map();
let tokenSeq = 0;
let cached;

async function currentCredential() {
  if (cached?.type === 'oauth' && cached.expires - Date.now() > TOKEN_REUSE_MARGIN_MS) return cached;
  const id = `t-${++tokenSeq}`;
  const reply = await new Promise((resolve) => {
    tokenWaiters.set(id, resolve);
    send({ type: 'token.get', id });
  });
  if (reply.error === 'not_connected') return undefined;
  if (reply.error || !reply.access || !reply.accountId || !reply.expires) throw new Reconnect('reconnect');
  // The refresh token stays with the gateway: this store can never refresh on its own.
  cached = { type: 'oauth', access: reply.access, refresh: 'held-by-host', expires: reply.expires, accountId: reply.accountId };
  return cached;
}

const credentials = {
  read: async (providerId) => providerId === PROVIDER ? currentCredential() : undefined,
  list: async () => [{ providerId: PROVIDER, type: 'oauth' }],
  // Pi refreshes inside `modify`. Here the gateway owns the refresh, so the callback is not
  // run and the answer is whatever the gateway holds now.
  modify: async (providerId) => {
    if (providerId !== PROVIDER) return undefined;
    cached = undefined;
    return currentCredential();
  },
  delete: async () => {},
};

// --- Login and refresh, on behalf of the gateway ---------------------------------------

let loginAbort;

async function login() {
  loginAbort?.abort();
  const abort = new AbortController();
  loginAbort = abort;
  try {
    const credential = await openaiCodexProvider().auth.oauth.login({
      signal: abort.signal,
      // Only the device-code flow works on a server; the browser flow redirects to localhost.
      prompt: async (prompt) => {
        if (prompt.type === 'select' && prompt.options.some((option) => option.id === 'device_code')) return 'device_code';
        throw new Error('unsupported login prompt');
      },
      notify: (event) => {
        if (event.type !== 'device_code') return;
        if (event.verificationUri !== DEVICE_VERIFICATION_URI) return abort.abort();
        send({ type: 'login.code', userCode: event.userCode });
      },
    });
    const stored = parseCredential(credential);
    if (abort.signal.aborted) return;
    send(stored ? { type: 'login.done', credential: stored } : { type: 'login.failed' });
  } catch {
    if (!abort.signal.aborted) send({ type: 'login.failed' });
  } finally {
    if (loginAbort === abort) loginAbort = undefined;
  }
}

async function refresh(message) {
  try {
    const next = parseCredential(await openaiCodexProvider().auth.oauth.refresh({ type: 'oauth', ...message.credential }, AbortSignal.timeout(30_000)));
    send(next ? { type: 'refresh.done', id: message.id, credential: next } : { type: 'refresh.failed', id: message.id });
  } catch {
    send({ type: 'refresh.failed', id: message.id });
  }
}

// --- The conversation --------------------------------------------------------------------

let runtimeReady;
let session;
/** The operator's allowlist, from `start`; unset means every model of the account. */
let allowedModels;
/** The account's models, listed once per process (a process lives at most an hour). */
let catalog;
let running = false;
let aborting = false;
/** Pi's call id -> the call number the protocol pairs `tool` and `draft` with. */
const calls = new Map();
let nextCall = 0;
const drafts = createDraftThrottle({ send });

/** No network here: the model catalog is refreshed when a list is first needed. */
function modelRuntime() {
  runtimeReady ??= ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: true, refreshOnCreate: false });
  return runtimeReady;
}

/** The visible models of the person's account, in the provider's own order, allowlist applied. */
async function listModels() {
  const runtime = await modelRuntime();
  const result = await runtime.refresh({ allowNetwork: true, providers: [PROVIDER], signal: AbortSignal.timeout(20_000) });
  const failure = result.errors.get(PROVIDER);
  if (failure) throw failure;
  const available = await runtime.getAvailable();
  // Only the person's own account may serve a request, whatever else pi has registered.
  if (available.some((model) => model.provider !== PROVIDER)) throw new Error('unexpected provider');
  const allowed = allowedModels;
  catalog = allowed ? available.filter((model) => allowed.includes(model.id)) : available;
  return catalog;
}

/** The model asked for when the account offers it and the allowlist allows it, else the first. */
async function chooseModel(active, wanted) {
  const models = catalog ?? await listModels();
  const usable = allowedModels ? models.filter((model) => allowedModels.includes(model.id)) : models;
  const pick = usable.find((model) => model.id === wanted) ?? usable[0];
  if (!pick) throw allowedModels ? new NoAllowedModel() : new Reconnect('reconnect');
  if (active.model?.provider !== PROVIDER || active.model.id !== pick.id) await active.setModel(pick);
}

/**
 * Pi 1.5.2's MCP extension has no include filter, so the restriction is the session's own:
 * keep active only the board tools of AGENT_TOOLS, then check nothing else is left. Returns
 * the active tool names, or null when the check fails (the caller then fails closed).
 */
function restrictTools(active) {
  active.setActiveToolsByName(active.getActiveToolNames().filter((name) => ALLOWED_TOOLS.has(name)));
  const tools = active.getActiveToolNames();
  return tools.length > 0 && tools.every((name) => ALLOWED_TOOLS.has(name)) ? tools : null;
}

/**
 * Clears the conversation's history and keeps the process, the MCP connection and the model.
 * Pi's session manager starts a new, empty session and the agent's messages are rebuilt.
 */
async function resetHistory() {
  try {
    if (session && !running) {
      const active = await session;
      active.sessionManager.newSession();
      active.refreshContext();
    }
  } catch {
    // No session could be created: there is no history to clear.
  }
  send({ type: 'reset.done' });
}

const callOf = (id) => {
  let call = calls.get(id);
  if (call === undefined) {
    nextCall = (nextCall % 100_000) + 1;
    call = nextCall;
    calls.set(id, call);
  }
  return call;
};

/** Streamed tool arguments become draft previews; see engine/draft.mjs. */
function onToolCallStream(event) {
  const kind = event.type;
  const block = kind === 'toolcall_end' ? event.toolCall : event.partial?.content?.[event.contentIndex];
  if (!block || block.type !== 'toolCall' || typeof block.id !== 'string') return;
  const call = callOf(block.id);
  const tool = baseToolName(block.name);
  if (!DRAFT_TOOLS.includes(tool)) return;
  if (kind === 'toolcall_end') drafts.final(call, draftElements(tool, block.arguments, true));
  else if (kind === 'toolcall_delta') drafts.update(call, draftElements(tool, block.arguments, false));
}

async function createSession(start) {
  const runtime = await modelRuntime();
  const settingsManager = SettingsManager.inMemory({ transport: 'sse' });
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => start.systemPrompt,
    appendSystemPromptOverride: () => [],
    extensionFactories: [createMcpExtension({
      // The one server, given here and never read from an mcp.json. `direct` declares its
      // tools to the model; the default exposure would switch on a script tool instead.
      loadConfig: () => ({
        servers: [{
          name: MCP_SERVER_NAME,
          source: 'host',
          config: { type: 'http', url: start.mcpUrl, headers: { Authorization: `Bearer ${start.mcpToken}` }, exposure: 'direct' },
        }],
        autoEnableCodemode: false,
        errors: [],
      }),
      logPath: join(agentDir, 'mcp.log'),
      openUrl: () => {},
    })],
  });
  await resourceLoader.reload();
  const model = runtime.getModels(PROVIDER)[0];
  if (!model) throw new Error('no model');
  const created = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime: runtime,
    model,
    resourceLoader,
    settingsManager,
    sessionManager: SessionManager.inMemory(cwd),
    // No shell, no file tools. Extension tools, which are the MCP tools, stay.
    noTools: 'builtin',
  });
  await created.session.bindExtensions({});

  // Wait for the MCP tools to appear, then until their number stops changing.
  const deadline = Date.now() + MCP_CONNECT_WAIT_MS;
  let tools = created.session.getActiveToolNames();
  let stable = 0;
  while (stable < 2 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    const next = created.session.getActiveToolNames();
    stable = next.some((name) => name.startsWith(MCP_TOOL_PREFIX)) && next.length === tools.length ? stable + 1 : 0;
    tools = next;
  }
  // Fail closed, here and again in the gateway: the board tools of AGENT_TOOLS and nothing else.
  const restricted = restrictTools(created.session);
  send({ type: 'session', tools: restricted ?? created.session.getActiveToolNames() });
  if (!restricted) {
    created.session.dispose();
    throw new Error('unexpected tools');
  }

  created.session.subscribe((event) => {
    if (!running) return;
    if (event.type === 'message_update') {
      const update = event.assistantMessageEvent;
      if (update.type === 'text_delta') send({ type: 'delta', text: update.delta });
      else if (update.type === 'thinking_delta') send({ type: 'thinking', text: update.delta });
      else if (update.type === 'toolcall_start' || update.type === 'toolcall_delta' || update.type === 'toolcall_end') onToolCallStream(update);
    } else if (event.type === 'tool_execution_start') {
      send({ type: 'tool', phase: 'start', call: callOf(event.toolCallId), name: event.toolName, ok: true });
    } else if (event.type === 'tool_execution_end') {
      const call = callOf(event.toolCallId);
      // The draft ends with the tool: the real elements arrive through the board's own socket.
      drafts.drop(call);
      calls.delete(event.toolCallId);
      send({ type: 'tool', phase: 'end', call, name: event.toolName, ok: !event.isError });
    }
  });
  return created.session;
}

async function prompt(text, model) {
  if (running) return send({ type: 'error', code: 'turn_in_progress' });
  if (!session) return send({ type: 'error', code: 'engine_unavailable' });
  running = true;
  aborting = false;
  try {
    let active;
    try {
      active = await session;
    } catch {
      send({ type: 'error', code: 'engine_unavailable' });
      return process.exit(1);
    }
    if (!restrictTools(active)) {
      send({ type: 'error', code: 'engine_unavailable' });
      return process.exit(1);
    }
    await chooseModel(active, model);
    await active.prompt(text);
    const last = active.messages.at(-1);
    if (aborting || last?.stopReason === 'aborted') send({ type: 'done', aborted: true });
    else if (last?.role === 'assistant' && last.stopReason === 'error') send({ type: 'error', code: toErrorCode(codeOf(last.errorMessage)) });
    else send({ type: 'done', aborted: false });
  } catch (error) {
    send(aborting ? { type: 'done', aborted: true } : { type: 'error', code: toErrorCode(codeOf(error)) });
  } finally {
    running = false;
    drafts.clear();
    calls.clear();
  }
}

// --- Messages from the gateway, validated ------------------------------------------------

const isSecret = (value) => typeof value === 'string' && value.length > 0 && value.length <= MAX_SECRET_CHARS;

/** The MCP endpoint is this board's loopback one; anything else is refused. */
function parseStart(m) {
  if (!isSecret(m.mcpUrl) || !isSecret(m.mcpToken)) return null;
  if (typeof m.systemPrompt !== 'string' || m.systemPrompt.length > MAX_SYSTEM_PROMPT_CHARS) return null;
  let url;
  try { url = new URL(m.mcpUrl); } catch { return null; }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return null;
  let models;
  if (m.allowedModels !== undefined) {
    if (!Array.isArray(m.allowedModels) || m.allowedModels.length > 32 || !m.allowedModels.every((id) => typeof id === 'string' && MODEL_ID.test(id))) return null;
    models = m.allowedModels;
  }
  return { mcpUrl: url.href, mcpToken: m.mcpToken, systemPrompt: m.systemPrompt, allowedModels: models };
}

function handle(m) {
  switch (m.type) {
    case 'start': {
      if (session) return;
      const start = parseStart(m);
      if (!start) return send({ type: 'error', code: 'engine_unavailable' });
      allowedModels = start.allowedModels;
      catalog = undefined;
      session = createSession(start);
      session.catch(() => send({ type: 'error', code: 'engine_unavailable' }));
      return;
    }
    case 'login.start':
      return void login();
    case 'login.cancel':
      return loginAbort?.abort();
    case 'refresh': {
      const credential = parseCredential(m.credential);
      if (typeof m.id !== 'string' || !ID.test(m.id)) return;
      return void (credential ? refresh({ id: m.id, credential }) : send({ type: 'refresh.failed', id: m.id }));
    }
    case 'token': {
      if (typeof m.id !== 'string') return;
      const reply = { error: m.error === undefined ? undefined : toErrorCode(m.error) };
      if (isSecret(m.access)) reply.access = m.access;
      if (isSecret(m.accountId)) reply.accountId = m.accountId;
      if (typeof m.expires === 'number' && Number.isFinite(m.expires) && m.expires > 0) reply.expires = m.expires;
      tokenWaiters.get(m.id)?.(reply);
      tokenWaiters.delete(m.id);
      return;
    }
    case 'prompt': {
      if (typeof m.text !== 'string' || !m.text.trim() || m.text.length > MAX_PROMPT_CHARS) return send({ type: 'error', code: 'provider_error' });
      const model = typeof m.model === 'string' && MODEL_ID.test(m.model) ? m.model : undefined;
      return void prompt(m.text, model);
    }
    case 'reset':
      return void resetHistory();
    case 'abort':
      aborting = running;
      return void session?.then((active) => active.abort(), () => {});
    case 'shutdown':
      return process.exit(0);
  }
}

const decoder = new LineDecoder();
process.stdin.on('data', (chunk) => {
  let values;
  try { values = decoder.push(chunk); } catch { return process.exit(1); }
  for (const value of values) {
    if (typeof value === 'object' && value !== null && !Array.isArray(value) && typeof value.type === 'string') handle(value);
  }
});
// The gateway is gone: so is this process.
process.stdin.on('end', () => process.exit(0));
process.on('uncaughtException', () => process.exit(1));
process.on('unhandledRejection', () => {});

send({ type: 'ready', piVersion: VERSION });
