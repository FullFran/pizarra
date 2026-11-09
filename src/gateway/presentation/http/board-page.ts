import http from 'node:http';
import type { CanvasUpstream } from '../../application/ports.js';

/** Path of the script every board page loads before upstream's bundle. */
export const BOARD_SCRIPT_PATH = '/__pizarra/board.js';

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Upstream's page asks for `/api/...` and opens its WebSocket at `/`, so on
 * `/b/<id>/` it would reach board main. This script, loaded first, points
 * those requests at `/b/<id>/...` (the page's own board), and shows a small
 * pizarra badge (board name, sign out) unless the page is opened with
 * `?embed=1`. Upstream's code is untouched.
 */
export const BOARD_SCRIPT = `(() => {
  const script = document.currentScript;
  const board = script && script.dataset.board;
  if (!board || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(board)) return;
  const prefix = '/b/' + board;
  const toBoard = value => {
    const url = new URL(value, window.location.href);
    if (url.origin !== window.location.origin || !/^\\/api(\\/|$)/i.test(url.pathname)) return null;
    url.pathname = prefix + url.pathname;
    return url.toString();
  };
  const originalFetch = window.fetch.bind(window);
  // Live edits from other people. Upstream broadcasts only \`elements_synced\` (a count) when a
  // browser syncs, and its page ignores it, so nobody sees a person's strokes until they reload.
  // On someone else's sync this page reads the board and hands its own handler what changed, as
  // the messages it already merges (\`elements_batch_created\`, \`element_deleted\`).
  const known = new Map();
  const IGNORED = new Set(['version', 'syncedAt', 'syncTimestamp', 'source', 'createdAt', 'updatedAt']);
  const print = element => JSON.stringify(Object.keys(element).sort().filter(key => !IGNORED.has(key)).map(key => [key, element[key]]));
  const remember = elements => { for (const element of elements) if (element && element.id) known.set(element.id, print(element)); };
  const reset = elements => { known.clear(); remember(elements); };
  let pendingEchoes = 0;
  let pulling = false;
  let pullAgain = false;
  let deliver = null;
  const pull = async () => {
    if (pulling) { pullAgain = true; return; }
    pulling = true;
    try {
      const response = await originalFetch(new URL(prefix + '/api/elements', window.location.href).toString(), { credentials: 'same-origin' });
      if (!response.ok) return;
      const body = await response.json();
      const elements = Array.isArray(body && body.elements) ? body.elements : [];
      const changed = elements.filter(element => element && element.id && known.get(element.id) !== print(element));
      const ids = new Set(elements.map(element => element && element.id));
      const removed = [...known.keys()].filter(id => !ids.has(id));
      reset(elements);
      if (!deliver) return;
      if (changed.length > 0) deliver({ type: 'elements_batch_created', elements: changed });
      for (const elementId of removed) deliver({ type: 'element_deleted', elementId });
    } catch {
      // The next sync tries again.
    } finally {
      pulling = false;
      if (pullAgain) { pullAgain = false; void pull(); }
    }
  };
  const observe = message => {
    if (!message || typeof message !== 'object') return;
    switch (message.type) {
      case 'initial_elements': if (Array.isArray(message.elements)) reset(message.elements); break;
      case 'element_created': case 'element_updated': if (message.element) remember([message.element]); break;
      case 'elements_batch_created': if (Array.isArray(message.elements)) remember(message.elements); break;
      case 'element_deleted': known.delete(message.elementId); break;
      case 'canvas_cleared': known.clear(); break;
      case 'elements_synced':
        if (pendingEchoes > 0) pendingEchoes -= 1;
        else void pull();
        break;
    }
  };
  const isSync = (url, init) => /\\/api\\/elements\\/sync$/.test(new URL(url, window.location.href).pathname) && String((init && init.method) || 'GET').toUpperCase() === 'POST';
  const trackSync = (promise, init) => {
    pendingEchoes += 1;
    try {
      const sent = JSON.parse(String(init.body));
      if (Array.isArray(sent && sent.elements)) reset(sent.elements);
    } catch {
      // Not JSON: upstream rejects it, and the next pull settles what this page knows.
    }
    return promise.then(response => {
      if (!response.ok) pendingEchoes = Math.max(0, pendingEchoes - 1);
      return response;
    }, error => {
      pendingEchoes = Math.max(0, pendingEchoes - 1);
      throw error;
    });
  };
  window.fetch = (input, init) => {
    if (typeof input === 'string' || input instanceof URL) {
      const rewritten = toBoard(String(input));
      const sent = originalFetch(rewritten || input, init);
      return rewritten && isSync(rewritten, init) ? trackSync(sent, init) : sent;
    }
    if (input instanceof Request) {
      const rewritten = toBoard(input.url);
      return originalFetch(rewritten ? new Request(rewritten, input) : input, init);
    }
    return originalFetch(input, init);
  };
  const NativeWebSocket = window.WebSocket;
  window.WebSocket = class extends NativeWebSocket {
    constructor(value, protocols) {
      const url = new URL(value, window.location.href);
      if (url.host === window.location.host && (url.pathname === '/' || url.pathname === '')) url.pathname = prefix + '/';
      super(url.toString(), protocols);
    }
    get onmessage() { return this.__pizarraHandler || null; }
    set onmessage(handler) {
      this.__pizarraHandler = handler;
      if (typeof handler !== 'function') { super.onmessage = handler; return; }
      deliver = message => handler.call(this, { data: JSON.stringify(message) });
      super.onmessage = event => {
        try { observe(JSON.parse(event.data)); } catch { /* not JSON: upstream's handler decides */ }
        return handler.call(this, event);
      };
    }
  };
  const embedded = new URLSearchParams(window.location.search).get('embed') === '1';
  if (embedded) return;
  const badge = () => {
    const bar = document.createElement('div');
    bar.setAttribute('data-pizarra-chrome', '');
    bar.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:2147483647;display:flex;gap:8px;align-items:center;padding:4px 8px;border-radius:8px;background:rgba(255,255,255,.92);border:1px solid #d9d9de;font:12px system-ui,sans-serif;color:#1d1d1f';
    const name = document.createElement('a');
    name.href = '/boards';
    name.textContent = script.dataset.name || board;
    name.style.cssText = 'color:inherit;font-weight:600;text-decoration:none';
    bar.appendChild(name);
    if (script.dataset.signout === '1') {
      const form = document.createElement('form');
      form.method = 'post';
      form.action = '/oauth/logout';
      form.style.margin = '0';
      const button = document.createElement('button');
      button.type = 'submit';
      button.textContent = 'Sign out';
      button.style.cssText = 'font:inherit;border:0;background:none;color:#6965db;cursor:pointer;padding:0';
      form.appendChild(button);
      bar.appendChild(form);
    }
    document.body.appendChild(bar);
  };
  if (document.body) badge(); else document.addEventListener('DOMContentLoaded', badge);
})();
`;

/** Fetches upstream's page through the pool (uncompressed) for the board's prefix. */
export function fetchBoardPage(upstream: CanvasUpstream, board: string): Promise<{ status: number; type: string; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: upstream.host, port: upstream.port, method: 'GET', path: `/b/${board}/`,
      headers: { host: `${upstream.host}:${upstream.port}`, accept: 'text/html', 'accept-encoding': 'identity' }, agent: false
    }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 502, type: String(res.headers['content-type'] ?? ''), body }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('board page timed out')));
    req.end();
  });
}

/** Upstream's page with the board script first in `<head>`. */
export function injectBoardScript(html: string, board: { id: string; name: string; signOut: boolean }): string {
  const tag = `<script src="${BOARD_SCRIPT_PATH}" data-board="${escapeAttribute(board.id)}" data-name="${escapeAttribute(board.name)}"${board.signOut ? ' data-signout="1"' : ''}></script>`;
  const head = /<head[^>]*>/i.exec(html);
  if (!head) return `${tag}${html}`;
  const at = head.index + head[0].length;
  return `${html.slice(0, at)}${tag}${html.slice(at)}`;
}
