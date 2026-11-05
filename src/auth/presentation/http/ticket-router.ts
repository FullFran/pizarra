import express from 'express';
import type { TrustedIssuerProvider } from '../../application/ticket-provider.js';
import type { CookieJar } from './http-helpers.js';
import { single } from './http-helpers.js';
import { sendErrorPage } from './pages.js';

const BOARD_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * `GET /b/<id>/enter?ticket=…[&embed=1]`: trades a trusted issuer's ticket
 * (single use) for a session cookie for that board, then goes to the board.
 * The ticket is never logged, and the next page gets no `Referer` carrying it.
 */
export function createTicketRouter(provider: TrustedIssuerProvider, cookies: CookieJar): express.Router {
  const router = express.Router({ caseSensitive: true });
  router.get('/b/:board/enter', async (req, res, next) => {
    try {
      const board = req.params.board ?? '';
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Cache-Control', 'no-store');
      if (!BOARD_ID.test(board)) return sendErrorPage(res, 404, 'Board not found', 'There is no such board.');
      const result = await provider.enter(single(req.query.ticket), board);
      if (!result.ok) {
        return sendErrorPage(res, result.status, 'Cannot open this board', 'This link is not valid any more. Open the board again from the application that sent you here.');
      }
      cookies.set(res, result.cookie.name, result.cookie.value, result.cookie.maxAgeSeconds);
      res.redirect(303, `/b/${result.board}/${single(req.query.embed) === '1' ? '?embed=1' : ''}`);
    } catch (error) {
      next(error);
    }
  });
  return router;
}
