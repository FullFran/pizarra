import type { DraftElement } from './protocol.js';

export type HubEvent =
  | { event: 'draft'; data: { id: string; elements: DraftElement[] } }
  | { event: 'draft.end'; data: { id: string } }
  | { event: 'agent'; data: { state: 'working' | 'idle'; login: string } };

export type HubListener = (event: HubEvent) => void;

/** What the engine manager says about drafts and activity. */
export interface AgentBroadcast {
  draft(board: string, id: string, elements: DraftElement[]): void;
  draftEnd(board: string, id: string): void;
  agent(board: string, state: 'working' | 'idle', login: string): void;
}

/** Most event streams one board keeps open at once. */
const MAX_LISTENERS_PER_BOARD = 100;

/**
 * Per-board broadcast to every viewer connected to the events stream. It keeps no history except
 * who is working now, which a new listener is told first.
 */
export class AgentHub implements AgentBroadcast {
  private readonly listeners = new Map<string, Set<HubListener>>();
  private readonly working = new Map<string, Set<string>>();

  /** Returns how to unsubscribe, or undefined when the board has too many streams open. */
  subscribe(board: string, listener: HubListener): (() => void) | undefined {
    let set = this.listeners.get(board);
    if (!set) {
      set = new Set();
      this.listeners.set(board, set);
    }
    if (set.size >= MAX_LISTENERS_PER_BOARD) return undefined;
    set.add(listener);
    for (const login of this.working.get(board) ?? []) listener({ event: 'agent', data: { state: 'working', login } });
    return () => {
      set.delete(listener);
      if (set.size === 0 && this.listeners.get(board) === set) this.listeners.delete(board);
    };
  }

  listenerCount(board: string): number {
    return this.listeners.get(board)?.size ?? 0;
  }

  draft(board: string, id: string, elements: DraftElement[]): void {
    this.publish(board, { event: 'draft', data: { id, elements } });
  }

  draftEnd(board: string, id: string): void {
    this.publish(board, { event: 'draft.end', data: { id } });
  }

  agent(board: string, state: 'working' | 'idle', login: string): void {
    let set = this.working.get(board);
    if (state === 'working') {
      if (!set) {
        set = new Set();
        this.working.set(board, set);
      }
      set.add(login);
    } else if (set) {
      set.delete(login);
      if (set.size === 0) this.working.delete(board);
    }
    this.publish(board, { event: 'agent', data: { state, login } });
  }

  private publish(board: string, event: HubEvent): void {
    for (const listener of [...(this.listeners.get(board) ?? [])]) {
      try {
        listener(event);
      } catch {
        // A broken stream must not stop the others.
      }
    }
  }
}
