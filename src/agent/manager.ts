import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Logger } from '../shared/logger.js';
import type { AgentBroadcast } from './hub.js';
import { AGENT_SYSTEM_PROMPT } from './prompt.js';
import { AGENT_TOOLS, DEVICE_VERIFICATION_URI, LineDecoder, MCP_TOOL_PREFIX, encode, parseChildMessage } from './protocol.js';
import type { ChildMessage, EngineErrorCode, ParentMessage, StoredCredential } from './protocol.js';
import type { EngineTokens } from './tokens.js';
import { CredentialVault } from './vault.js';

/** The engine program, next to `dist/` in the image and in a checkout. */
export const DEFAULT_ENGINE_ENTRY = fileURLToPath(new URL('../../engine/main.mjs', import.meta.url));

export interface AgentManagerSettings {
  vault: CredentialVault;
  tokens: EngineTokens;
  hub: AgentBroadcast;
  /** Where an engine process reaches one board's MCP endpoint, on loopback. */
  mcpUrl: (board: string) => string;
  /** At most this many engine processes run at once. */
  maxProcesses: number;
  allowedModels?: string[];
  systemPrompt?: string;
  /** The engine program, run with this Node. Tests substitute a fake. */
  entry?: string;
  logger?: Logger;
  /** A process with nothing to do is stopped after this long. */
  idleMs?: number;
  /** A process, and with it its MCP token, lives at most this long. */
  maxAgeMs?: number;
  /** A credential this close to expiry is refreshed before it is handed out. */
  refreshMarginMs?: number;
  /** How long the gateway waits for the process to answer a login start or a refresh. */
  replyTimeoutMs?: number;
  /** A pending device login is dropped, and its process stopped, after this long. */
  loginTtlMs?: number;
  loginLimit?: number;
  loginWindowMs?: number;
  /** Wall-clock limit of one turn. */
  turnTimeoutMs?: number;
  /** Most answer text one turn may stream, in bytes. */
  turnMaxBytes?: number;
  /** How long an aborted turn has to settle before its process is stopped. */
  abortGraceMs?: number;
  /** How long a stopping process is kept so a refresh already sent can come back. */
  refreshGraceMs?: number;
}

export class EngineError extends Error {
  readonly code: EngineErrorCode;

  constructor(code: EngineErrorCode) {
    super(code);
    this.code = code;
  }
}

export const ENGINE_HTTP_STATUS: Record<EngineErrorCode, number> = {
  busy: 429,
  rate_limited: 429,
  turn_in_progress: 409,
  not_connected: 409,
  reconnect: 409,
  engine_unavailable: 503,
  model_busy: 503,
  provider_error: 502,
  login_failed: 502,
  turn_limit: 504,
  model_unavailable: 400
};

export interface TurnSink {
  event(name: 'delta' | 'thinking' | 'tool' | 'done' | 'error', data: object): void;
}

export interface AgentStatus {
  connected: boolean;
  busy: boolean;
  pending: { userCode: string; verificationUri: string } | null;
}

const KILL_GRACE_MS = 2_000;
/** Previews one process may keep open at once. */
const MAX_OPEN_DRAFTS = 32;
const AGENT_TOOL_SET: ReadonlySet<string> = new Set(AGENT_TOOLS);

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  // Every waiter handles the rejection itself; this keeps a late one from being unhandled.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

interface Login {
  proc: Proc;
  userCode?: string;
  code: Deferred<string>;
  expiry: NodeJS.Timeout;
}

interface Turn {
  sink: TurnSink;
  end: () => void;
  bytes: number;
  /** Set when the turn passed its time or size limit: whatever comes next, it ends as `turn_limit`. */
  limited: boolean;
  timeout: NodeJS.Timeout;
  abortTimer?: NodeJS.Timeout;
  /** Calls whose tool already ended: a late preview of one is dropped. */
  ended: Set<number>;
}

interface Proc {
  login: string;
  board: string;
  /** Short random name of this process, the prefix of its preview ids on the board. */
  tag: string;
  child: ChildProcess;
  decoder: LineDecoder;
  startedAt: number;
  token?: string;
  toolsChecked: boolean;
  idle?: NodeJS.Timeout;
  turn?: Turn;
  /** Calls with a preview open on the board. */
  drafts: Set<number>;
  working: boolean;
  refreshes: Map<string, Deferred<StoredCredential>>;
  /** A history reset sent and not yet confirmed. */
  resetting?: { reply: Deferred<void>; timeout: NodeJS.Timeout };
  /** Detached from its person: it takes no new work. It may still deliver a refresh. */
  stopped: boolean;
  /** The person disconnected: a refresh that comes back is thrown away. */
  discard: boolean;
  exited: boolean;
}

interface Person {
  login: string;
  /** One engine process per board. */
  procs: Map<string, Proc>;
  pending?: Login;
  reconnect: boolean;
  refreshing?: Promise<StoredCredential>;
  /** When this person started logins, within the rate-limit window. */
  loginStarts: number[];
}

/**
 * Starts, feeds and stops the engine processes: at most one per person and board, started on
 * first use and stopped when idle, with a cap on how many run at once. It owns the stored
 * credentials and is the only place that refreshes one (one refresh at a time per person, even
 * across boards), so a rotating refresh token is never used twice.
 */
export class AgentManager {
  private readonly s: Required<Omit<AgentManagerSettings, 'allowedModels' | 'logger'>>;
  private readonly allowedModels: string[] | undefined;
  private readonly logger: Logger | undefined;
  private readonly people = new Map<string, Person>();
  /** Every process not yet torn down, attached to a person or finishing a refresh. */
  private readonly alive = new Set<Proc>();
  private scratch: string | undefined;
  private closed = false;

  constructor(settings: AgentManagerSettings) {
    this.s = {
      entry: DEFAULT_ENGINE_ENTRY, systemPrompt: AGENT_SYSTEM_PROMPT,
      idleMs: 5 * 60_000, maxAgeMs: 60 * 60_000, refreshMarginMs: 10 * 60_000, replyTimeoutMs: 60_000,
      loginTtlMs: 15 * 60_000, loginLimit: 3, loginWindowMs: 15 * 60_000,
      turnTimeoutMs: 10 * 60_000, turnMaxBytes: 2 * 1024 * 1024, abortGraceMs: 5_000, refreshGraceMs: 10_000,
      ...Object.fromEntries(Object.entries(settings).filter(([, value]) => value !== undefined))
    } as typeof this.s;
    this.allowedModels = settings.allowedModels;
    this.logger = settings.logger;
  }

  /** Processes that hold a slot. */
  liveCount(): number {
    let count = 0;
    for (const person of this.people.values()) count += person.procs.size;
    return count;
  }

  status(login: string, board: string): AgentStatus {
    const person = this.people.get(login);
    const proc = person?.procs.get(board);
    const pending = person?.pending && person.pending.proc.board === board && person.pending.userCode
      ? { userCode: person.pending.userCode, verificationUri: DEVICE_VERIFICATION_URI } : null;
    let connected = false;
    try {
      connected = this.s.vault.read(login) !== null && !person?.reconnect;
    } catch {
      connected = false;
    }
    return { connected: connected && pending === null, busy: proc?.turn !== undefined, pending };
  }

  /**
   * Starts a device-code login for this person on this board. One at a time per person: a new one
   * cancels the previous. A login holds a process without a credential, so starts are
   * rate-limited per person and the login has a hard deadline.
   */
  async startLogin(login: string, board: string): Promise<{ userCode: string; verificationUri: string }> {
    this.sweep();
    const person = this.personOf(login);
    if (person.loginStarts.length >= this.s.loginLimit) throw new EngineError('rate_limited');
    person.loginStarts.push(Date.now());
    if (person.pending) this.endLogin(person, 'login_failed', true, true);
    let proc: Proc;
    try {
      proc = this.ensureProc(person, board, false);
    } catch (error) {
      this.forget(person);
      throw error;
    }
    const pending: Login = {
      proc,
      code: deferred<string>(),
      expiry: setTimeout(() => { if (person.pending === pending) this.endLogin(person, 'login_failed', true); }, this.s.loginTtlMs)
    };
    pending.expiry.unref();
    person.pending = pending;
    this.send(proc, { type: 'login.start' });
    this.touch(person, proc);
    const timeout = setTimeout(() => pending.code.reject(new EngineError('engine_unavailable')), this.s.replyTimeoutMs);
    timeout.unref();
    try {
      const userCode = await pending.code.promise;
      return { userCode, verificationUri: DEVICE_VERIFICATION_URI };
    } catch (error) {
      if (person.pending === pending) this.endLogin(person, 'engine_unavailable', true);
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Removes the stored credential, stops every process of the person and revokes their tokens. */
  disconnect(login: string): void {
    const person = this.people.get(login);
    if (person) for (const proc of [...person.procs.values()]) this.stop(person, 'disconnect', proc);
    this.s.vault.delete(login);
    if (person) {
      person.reconnect = false;
      this.forget(person);
    }
  }

  /**
   * Clears the history of the conversation on this board, which keeps running. With no process
   * there is nothing to clear. A process that does not confirm in time is stopped, which clears
   * the history as well.
   */
  async reset(login: string, board: string): Promise<void> {
    const person = this.people.get(login);
    const proc = person?.procs.get(board);
    if (!person || !proc?.token || proc.stopped) return;
    if (proc.turn) throw new EngineError('turn_in_progress');
    if (!proc.resetting) {
      const reply = deferred<void>();
      const timeout = setTimeout(() => this.stop(person, 'reset_timeout', proc), this.s.replyTimeoutMs);
      timeout.unref();
      proc.resetting = { reply, timeout };
      this.send(proc, { type: 'reset' });
      this.touch(person, proc);
    }
    await proc.resetting.reply.promise;
  }

  /**
   * Runs one turn. Refusals are thrown before anything is streamed; after that every outcome,
   * failures included, arrives through the sink. Resolves when the turn ends.
   */
  prompt(login: string, board: string, text: string, sink: TurnSink): Promise<void> {
    if (this.closed) throw new EngineError('engine_unavailable');
    if (this.people.get(login)?.procs.get(board)?.turn) throw new EngineError('turn_in_progress');
    if (!this.hasCredential(login)) throw new EngineError('not_connected');
    const person = this.personOf(login);
    const old = person.procs.get(board);
    if (old && person.pending?.proc !== old && Date.now() - old.startedAt > this.s.maxAgeMs - this.s.refreshMarginMs) {
      this.stop(person, 'max_age', old);
    }
    const proc = this.ensureProc(person, board, true);
    if (!proc.token) {
      proc.token = this.s.tokens.mint({ login, board }, this.s.maxAgeMs);
      this.send(proc, {
        type: 'start', mcpUrl: this.s.mcpUrl(board), mcpToken: proc.token, systemPrompt: this.s.systemPrompt,
        ...(this.allowedModels ? { allowedModels: this.allowedModels } : {})
      });
    }
    return new Promise<void>(resolve => {
      const timeout = setTimeout(() => this.limitTurn(person, proc), this.s.turnTimeoutMs);
      timeout.unref();
      proc.turn = { sink, end: resolve, bytes: 0, limited: false, timeout, ended: new Set() };
      this.setWorking(proc, true);
      this.send(proc, { type: 'prompt', text });
      this.touch(person, proc);
    });
  }

  /** Asks the running turn of this person on this board to stop. False when there is none. */
  abort(login: string, board: string): boolean {
    const person = this.people.get(login);
    const proc = person?.procs.get(board);
    if (!person || !proc?.turn) return false;
    this.requestAbort(person, proc, 'abort_timeout');
    return true;
  }

  /**
   * Stops every process and revokes every token; the manager accepts no work afterwards.
   * Resolves when every process is gone, which waits (bounded) for a refresh in flight.
   */
  async close(): Promise<void> {
    this.closed = true;
    for (const person of this.people.values()) for (const proc of [...person.procs.values()]) this.stop(person, 'shutdown', proc);
    this.people.clear();
    await Promise.all([...this.alive].map(proc => new Promise<void>(resolve => {
      if (proc.exited) return resolve();
      proc.child.once('exit', () => resolve());
    })));
    this.removeScratch();
  }

  /** Last resort at process exit: nothing can be waited for any more. */
  killAll(): void {
    for (const proc of this.alive) proc.child.kill('SIGKILL');
    this.removeScratch();
  }

  private personOf(login: string): Person {
    let person = this.people.get(login);
    if (!person) {
      person = { login, procs: new Map(), reconnect: false, loginStarts: [] };
      this.people.set(login, person);
    }
    return person;
  }

  /** True when a credential file exists and is readable. */
  private hasCredential(login: string): boolean {
    try {
      return this.s.vault.read(login) !== null;
    } catch {
      this.personOf(login).reconnect = true;
      throw new EngineError('reconnect');
    }
  }

  /** Drops the entry of a person the manager no longer needs to remember anything about. */
  private forget(person: Person): void {
    const now = Date.now();
    person.loginStarts = person.loginStarts.filter(at => now - at < this.s.loginWindowMs);
    if (person.procs.size > 0 || person.pending || person.refreshing || person.reconnect || person.loginStarts.length > 0) return;
    if (this.people.get(person.login) === person) this.people.delete(person.login);
  }

  private sweep(): void {
    for (const person of [...this.people.values()]) this.forget(person);
  }

  /** A scratch directory that is each engine's working directory and HOME: nothing of the gateway's is in it. */
  private scratchDir(): string {
    this.scratch ??= mkdtempSync(join(tmpdir(), 'pizarra-agent-'));
    return this.scratch;
  }

  private removeScratch(): void {
    if (!this.scratch) return;
    rmSync(this.scratch, { recursive: true, force: true });
    this.scratch = undefined;
  }

  private ensureProc(person: Person, board: string, forTurn: boolean): Proc {
    if (this.closed) throw new EngineError('engine_unavailable');
    const existing = person.procs.get(board);
    if (existing) return existing;
    if (this.liveCount() >= this.s.maxProcesses && forTurn) this.evictPendingLogin();
    if (this.liveCount() >= this.s.maxProcesses) throw new EngineError('busy');
    // An explicit, minimal environment: nothing of the operator's (keys, tokens) reaches the engine,
    // and stderr is discarded because provider errors can quote response bodies.
    const scratch = this.scratchDir();
    let child: ChildProcess;
    try {
      child = spawn(process.execPath, [this.s.entry], {
        stdio: ['pipe', 'pipe', 'ignore'], cwd: scratch, env: { PATH: process.env.PATH ?? '', HOME: scratch, TMPDIR: scratch }
      });
    } catch {
      throw new EngineError('engine_unavailable');
    }
    const proc: Proc = {
      login: person.login, board, tag: randomBytes(4).toString('hex'), child, decoder: new LineDecoder(), startedAt: Date.now(),
      toolsChecked: false, drafts: new Set(), working: false, refreshes: new Map(), stopped: false, discard: false, exited: false
    };
    person.procs.set(board, proc);
    this.alive.add(proc);
    const gone = (reason: string) => {
      proc.exited = true;
      this.alive.delete(proc);
      for (const reply of proc.refreshes.values()) reply.reject(new EngineError('reconnect'));
      this.stop(person, reason, proc);
    };
    child.on('error', () => gone('spawn_error'));
    child.on('exit', () => gone('exit'));
    child.stdin!.on('error', () => { /* the process is gone; `exit` cleans up */ });
    child.stdout!.on('data', (chunk: Buffer) => {
      let values: unknown[];
      try {
        values = proc.decoder.push(chunk);
      } catch {
        return this.stop(person, 'protocol', proc);
      }
      for (const value of values) {
        const message = parseChildMessage(value);
        if (!message) continue;
        // A stopped process is heard only for the refresh it was already asked for.
        if (!proc.stopped || message.type === 'refresh.done' || message.type === 'refresh.failed') this.handle(person, proc, message);
      }
    });
    this.log('start', 'first_use');
    this.touch(person, proc);
    return proc;
  }

  /** A turn of a connected person comes before a process that only waits for a device code. */
  private evictPendingLogin(): void {
    let oldest: Person | undefined;
    for (const person of this.people.values()) {
      const pending = person.pending;
      if (!pending || pending.proc.turn) continue;
      if (!oldest || pending.proc.startedAt < oldest.pending!.proc.startedAt) oldest = person;
    }
    if (oldest) this.endLogin(oldest, 'busy', true);
  }

  private handle(person: Person, proc: Proc, message: ChildMessage): void {
    switch (message.type) {
      case 'ready':
        return;
      case 'login.code':
        if (person.pending?.proc === proc) {
          person.pending.userCode = message.userCode;
          person.pending.code.resolve(message.userCode);
        }
        return;
      case 'login.done':
        if (person.pending?.proc !== proc) return;
        try {
          this.s.vault.write(person.login, message.credential);
          person.reconnect = false;
          this.endLogin(person, 'login_failed', false);
        } catch {
          this.endLogin(person, 'engine_unavailable', false);
        }
        return;
      case 'login.failed':
        if (person.pending?.proc === proc) this.endLogin(person, 'login_failed', false);
        return;
      case 'refresh.done':
        proc.refreshes.get(message.id)?.resolve(message.credential);
        return;
      case 'refresh.failed':
        proc.refreshes.get(message.id)?.reject(new EngineError('reconnect'));
        return;
      case 'token.get':
        void this.answerToken(person, proc, message.id);
        return;
      case 'session':
        // Fail closed: the engine may hold the board's agent tools and nothing else.
        if (message.tools.length === 0 || message.tools.some(tool => !tool.startsWith(MCP_TOOL_PREFIX) || !AGENT_TOOL_SET.has(tool.slice(MCP_TOOL_PREFIX.length)))) {
          return this.stop(person, 'unexpected_tools', proc);
        }
        proc.toolsChecked = true;
        return;
      case 'delta':
      case 'thinking': {
        const turn = proc.turn;
        if (!turn || turn.limited || !proc.toolsChecked) return;
        turn.bytes += Buffer.byteLength(message.text, 'utf8');
        if (turn.bytes > this.s.turnMaxBytes) return this.limitTurn(person, proc);
        turn.sink.event(message.type, { text: message.text });
        return;
      }
      case 'draft': {
        const turn = proc.turn;
        if (!turn || turn.limited || !proc.toolsChecked || turn.ended.has(message.call) || message.elements.length === 0) return;
        if (!proc.drafts.has(message.call) && proc.drafts.size >= MAX_OPEN_DRAFTS) return;
        proc.drafts.add(message.call);
        this.s.hub.draft(proc.board, `${proc.tag}-${message.call}`, message.elements);
        return;
      }
      case 'tool': {
        const turn = proc.turn;
        if (!turn || turn.limited || !proc.toolsChecked) return;
        if (!message.name.startsWith(MCP_TOOL_PREFIX)) return;
        const name = message.name.slice(MCP_TOOL_PREFIX.length);
        if (!AGENT_TOOL_SET.has(name)) return;
        if (message.phase === 'end') {
          turn.ended.add(message.call);
          this.endDraft(proc, message.call);
        }
        turn.sink.event('tool', { call: message.call, name, phase: message.phase, ok: message.ok });
        return;
      }
      case 'done':
        if (!proc.toolsChecked) return this.stop(person, 'unexpected_tools', proc);
        return this.endTurn(person, proc, 'done', { aborted: message.aborted });
      case 'error':
        if (message.code === 'reconnect') person.reconnect = true;
        return this.endTurn(person, proc, 'error', { code: message.code });
      case 'reset.done': {
        const resetting = proc.resetting;
        if (!resetting) return;
        proc.resetting = undefined;
        clearTimeout(resetting.timeout);
        resetting.reply.resolve();
        return;
      }
    }
  }

  private endDraft(proc: Proc, call: number): void {
    if (!proc.drafts.delete(call)) return;
    this.s.hub.draftEnd(proc.board, `${proc.tag}-${call}`);
  }

  private closeDrafts(proc: Proc): void {
    for (const call of [...proc.drafts]) this.endDraft(proc, call);
  }

  private setWorking(proc: Proc, working: boolean): void {
    if (proc.working === working) return;
    proc.working = working;
    this.s.hub.agent(proc.board, working ? 'working' : 'idle', proc.login);
  }

  private async answerToken(person: Person, proc: Proc, id: string): Promise<void> {
    try {
      const credential = await this.freshCredential(person, proc);
      this.send(proc, { type: 'token', id, access: credential.access, accountId: credential.accountId, expires: credential.expires });
    } catch (error) {
      this.send(proc, { type: 'token', id, error: error instanceof EngineError ? error.code : 'engine_unavailable' });
    }
  }

  /** Single flight: every caller that arrives during a refresh waits for that one refresh. */
  private freshCredential(person: Person, proc: Proc): Promise<StoredCredential> {
    if (person.refreshing) return person.refreshing;
    let credential: StoredCredential | null;
    try {
      credential = this.s.vault.read(person.login);
    } catch {
      person.reconnect = true;
      return Promise.reject(new EngineError('reconnect'));
    }
    if (!credential) return Promise.reject(new EngineError('not_connected'));
    if (credential.expires - Date.now() > this.s.refreshMarginMs) return Promise.resolve(credential);
    const refreshing = this.refresh(person, proc, credential).finally(() => {
      if (person.refreshing === refreshing) person.refreshing = undefined;
      this.forget(person);
    });
    refreshing.catch(() => {});
    person.refreshing = refreshing;
    return refreshing;
  }

  private async refresh(person: Person, proc: Proc, credential: StoredCredential): Promise<StoredCredential> {
    const id = randomUUID();
    const reply = deferred<StoredCredential>();
    proc.refreshes.set(id, reply);
    const timeout = setTimeout(() => reply.reject(new EngineError('reconnect')), this.s.replyTimeoutMs);
    timeout.unref();
    this.send(proc, { type: 'refresh', id, credential });
    try {
      const next = await reply.promise;
      // The old refresh token is spent once the new one exists, so the new one is stored even if
      // the process was stopped meanwhile. Only a disconnect throws it away.
      if (proc.discard) throw new EngineError('reconnect');
      this.s.vault.write(person.login, next);
      person.reconnect = false;
      return next;
    } catch {
      // The stored credential is left as it was; the person has to connect again.
      if (!proc.discard) person.reconnect = true;
      throw new EngineError('reconnect');
    } finally {
      clearTimeout(timeout);
      proc.refreshes.delete(id);
    }
  }

  /**
   * Ends a login. A process that is left with no pending login and no stored credential has
   * nothing to do and is stopped, unless `keepProcess` (a new login follows at once).
   */
  private endLogin(person: Person, code: EngineErrorCode, cancel: boolean, keepProcess = false): void {
    const pending = person.pending;
    if (!pending) return;
    person.pending = undefined;
    clearTimeout(pending.expiry);
    pending.code.reject(new EngineError(code));
    const proc = pending.proc;
    if (cancel) this.send(proc, { type: 'login.cancel' });
    if (keepProcess || proc.stopped || proc.turn) return;
    let connected = true;
    try { connected = this.s.vault.read(person.login) !== null; } catch { /* a file exists */ }
    if (!connected) this.stop(person, 'login_ended', proc);
  }

  /** The turn passed its time or size limit: ask it to stop, and stop the process if it does not. */
  private limitTurn(person: Person, proc: Proc): void {
    const turn = proc.turn;
    if (!turn || turn.limited) return;
    turn.limited = true;
    this.requestAbort(person, proc, 'turn_limit');
  }

  private requestAbort(person: Person, proc: Proc, reason: string): void {
    if (!proc.turn) return;
    this.send(proc, { type: 'abort' });
    proc.turn.abortTimer ??= setTimeout(() => this.stop(person, reason, proc), this.s.abortGraceMs);
    proc.turn.abortTimer.unref();
  }

  private endTurn(person: Person, proc: Proc, name: 'done' | 'error', data: object): void {
    const turn = proc.turn;
    if (!turn) return;
    proc.turn = undefined;
    clearTimeout(turn.timeout);
    clearTimeout(turn.abortTimer);
    // The previews of this process end with its turn, whatever the tools did.
    this.closeDrafts(proc);
    this.setWorking(proc, false);
    if (turn.limited) turn.sink.event('error', { code: 'turn_limit' });
    else turn.sink.event(name, data);
    turn.end();
    this.touch(person, proc);
  }

  private touch(person: Person, proc: Proc): void {
    clearTimeout(proc.idle);
    if (proc.stopped) return;
    proc.idle = setTimeout(() => {
      // A pending login has its own deadline, and a turn its own limit.
      if (proc.turn || person.pending?.proc === proc) return this.touch(person, proc);
      this.stop(person, 'idle', proc);
    }, this.s.idleMs);
    proc.idle.unref();
  }

  private send(proc: Proc, message: ParentMessage): void {
    if (proc.stopped || proc.exited || !proc.child.stdin?.writable) return;
    proc.child.stdin.write(encode(message));
  }

  /**
   * Detaches a process from its person at once: the slot is free, the token is revoked, the turn
   * and the login end, its previews leave the board. The process itself is torn down right away,
   * unless a refresh was already sent to it: then it is kept, bounded, until that refresh is back.
   */
  private stop(person: Person, reason: string, proc: Proc): void {
    if (proc.stopped) return;
    if (reason === 'disconnect') proc.discard = true;
    proc.stopped = true;
    if (person.procs.get(proc.board) === proc) person.procs.delete(proc.board);
    clearTimeout(proc.idle);
    if (proc.token) this.s.tokens.revoke(proc.token);
    this.endTurn(person, proc, 'error', { code: 'engine_unavailable' });
    this.closeDrafts(proc);
    this.setWorking(proc, false);
    // A stopped process holds no history: a reset waiting for it is done.
    if (proc.resetting) {
      clearTimeout(proc.resetting.timeout);
      proc.resetting.reply.resolve();
      proc.resetting = undefined;
    }
    if (person.pending?.proc === proc) this.endLogin(person, 'engine_unavailable', false, true);
    this.log('stop', reason);

    const teardown = () => {
      for (const reply of proc.refreshes.values()) reply.reject(new EngineError('reconnect'));
      if (proc.exited) return;
      if (proc.child.stdin?.writable) proc.child.stdin.end(encode({ type: 'shutdown' }));
      setTimeout(() => proc.child.kill('SIGKILL'), KILL_GRACE_MS).unref();
    };
    const pending = [...proc.refreshes.values()].map(reply => reply.promise.catch(() => {}));
    if (pending.length === 0 || proc.discard || proc.exited) teardown();
    else {
      const grace = setTimeout(teardown, this.s.refreshGraceMs);
      // Give the refresh's own continuation (the write to the vault) its turn first.
      void Promise.all(pending).then(() => setImmediate(() => { clearTimeout(grace); teardown(); }));
    }
    this.forget(person);
  }

  /** Metadata only: no login, no token, nothing the process said. */
  private log(action: 'start' | 'stop', reason: string): void {
    this.logger?.info('agent engine process', { action, reason, live: this.liveCount() });
  }
}
