import express from 'express';
import type { RequestHandler } from 'express';
import type { BoardDirectory } from '../../application/ports.js';
import { sendOutcome } from './responses.js';
import type { SessionCheck } from './responses.js';

export interface MembersRouterDeps {
  boards: BoardDirectory;
  requireSession: SessionCheck;
  writeGuard: RequestHandler;
  json: RequestHandler;
}

/**
 * Members of a GitHub board (issue #5): its owners (and the admins) invite
 * GitHub logins as editors or viewers, change their role and remove them.
 * `GET/PUT/DELETE /b/<id>/members[/<login>]`, JSON, browser session only.
 */
export function createMembersRouter(deps: MembersRouterDeps): express.Router {
  const { boards, requireSession, writeGuard, json } = deps;
  const router = express.Router({ caseSensitive: true });
  const members = (value: Record<string, 'editor' | 'viewer'>) => ({ members: Object.entries(value).map(([login, role]) => ({ login, role })) });
  router.get('/b/:board/members', (req, res) => {
    const principal = requireSession(req, res);
    if (principal === false) return;
    sendOutcome(res, boards.members(principal, req.params.board ?? ''), members);
  });
  router.put('/b/:board/members/:login', writeGuard, json, (req, res) => {
    const principal = requireSession(req, res);
    if (principal === false) return;
    sendOutcome(res, boards.setMember(principal, req.params.board ?? '', req.params.login, (req.body ?? {}).role), members);
  });
  router.delete('/b/:board/members/:login', writeGuard, (req, res) => {
    const principal = requireSession(req, res);
    if (principal === false) return;
    sendOutcome(res, boards.removeMember(principal, req.params.board ?? '', req.params.login), members);
  });
  return router;
}
