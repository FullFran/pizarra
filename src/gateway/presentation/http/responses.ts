import type { Request, Response } from 'express';
import type { BoardOutcome, Principal } from '../../application/ports.js';

/** The browser session (any board's) of a request; undefined with auth off; false after answering 401. */
export type SessionCheck = (req: Request, res: Response) => Principal | undefined | false;

const OUTCOME_STATUS = { not_found: 404, forbidden: 403, invalid: 400, exists: 409 } as const;

export function sendOutcome<T>(res: Response, outcome: BoardOutcome<T>, ok: (value: T) => unknown, okStatus = 200): void {
  res.setHeader('Cache-Control', 'no-store');
  if (!outcome.ok) {
    res.status(OUTCOME_STATUS[outcome.error]).json({ success: false, error: outcome.message });
    return;
  }
  res.status(okStatus).json(ok(outcome.value));
}
