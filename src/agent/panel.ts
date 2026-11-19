/** Path of the script that renders the agent's draft previews and (when enabled) its side panel. */
export const AGENT_SCRIPT_PATH = '/__pizarra/agent.js';

/**
 * Browser side of the board agent, loaded after BOARD_SCRIPT (`injectBoardScript(..., { agent: true })`).
 *
 * Every viewer: listens to `/b/<board>/__agent/events` and draws the shapes the agent is still
 * streaming as provisional elements (ids `pizarra-draft-...`, half transparent, locked) through
 * the hook BOARD_SCRIPT exposes (`window.__pizarraDeliver`), which feeds upstream's own message
 * handler. BOARD_SCRIPT keeps them out of every sync, so they are never saved.
 *
 * Signed-in viewers of a board with the feature on (not `?embed=1`): a small collapsible panel
 * with device-code sign-in, a prompt box and the live turn (narration, thinking, steps). Text
 * from the model or the server only ever reaches the page through `textContent`.
 */
export const AGENT_SCRIPT = String.raw`(() => {
  const script = document.currentScript;
  const board = script && script.dataset.board;
  if (!board || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(board)) return;
  const base = '/b/' + board + '/__agent';
  const embedded = new URLSearchParams(window.location.search).get('embed') === '1';
  const DRAFT = 'pizarra-draft-';
  const DEVICE_URI = 'https://auth.openai.com/codex/device';
  const CODE = /^[A-Z0-9][A-Z0-9-]{2,18}[A-Z0-9]$/;
  // THINKING_LEVELS of protocol.ts, lowest first (a unit test keeps them equal).
  const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  const CHOICE_KEY = 'pizarra.agent.choice';
  const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
  const COLOR = /^(#[0-9A-Fa-f]{3,8}|[a-z]{3,20}|transparent)$/;
  const num = (value, fallback) => (typeof value === 'number' && isFinite(value) ? value : fallback);
  const color = (value, fallback) => (typeof value === 'string' && COLOR.test(value) ? value : fallback);
  const h = (tag, css, text) => {
    const node = document.createElement(tag);
    if (css) node.style.cssText = css;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  // ---- Draft previews (every viewer) ----
  const shown = new Map();
  const draftElements = (id, drafts) => {
    const out = [];
    drafts.forEach((d, i) => {
      if (!d || typeof d !== 'object') return;
      const type = d.type;
      if (!['rectangle', 'ellipse', 'diamond', 'arrow', 'line', 'text'].includes(type)) return;
      const eid = DRAFT + id + '-' + i;
      const x = num(d.x, 0);
      const y = num(d.y, 0);
      const width = Math.max(0, num(d.width, 0));
      const height = Math.max(0, num(d.height, 0));
      const common = {
        id: eid, type, x, y, angle: 0, fillStyle: 'solid', groupIds: [], frameId: null, roundness: null,
        strokeColor: color(d.strokeColor, '#1e1e1e'),
        backgroundColor: type === 'text' ? 'transparent' : color(d.backgroundColor, 'transparent'),
        strokeWidth: num(d.strokeWidth, 2),
        strokeStyle: d.strokeStyle === 'dashed' || d.strokeStyle === 'dotted' ? d.strokeStyle : 'solid',
        roughness: num(d.roughness, 1),
        opacity: Math.min(num(d.opacity, 100), 50),
        seed: 1000 + i, version: 1, versionNonce: 1000 + i, isDeleted: false, boundElements: null, link: null, locked: true,
      };
      if (type === 'text') {
        out.push({ ...common, text: typeof d.text === 'string' ? d.text : '', fontSize: num(d.fontSize, 20), fontFamily: num(d.fontFamily, 5), textAlign: 'left', verticalAlign: 'top' });
        return;
      }
      if (type === 'arrow' || type === 'line') {
        out.push({
          ...common, width, height, points: [[0, 0], [width, height]],
          startArrowhead: type === 'arrow' && typeof d.startArrowhead === 'string' ? d.startArrowhead : null,
          endArrowhead: type === 'arrow' ? (d.endArrowhead === null ? null : typeof d.endArrowhead === 'string' ? d.endArrowhead : 'arrow') : null,
        });
        return;
      }
      out.push({ ...common, width, height });
      if (typeof d.text === 'string' && d.text) {
        // A label is a separate text element laid over the shape, so retiring the draft is just deleting ids.
        const size = num(d.fontSize, 20);
        const lines = d.text.split('\n');
        const longest = Math.max(...lines.map(line => line.length));
        const textWidth = longest * size * 0.6;
        const textHeight = lines.length * size * 1.25;
        out.push({
          ...common, id: eid + '-text', type: 'text', backgroundColor: 'transparent', text: d.text, fontSize: size, fontFamily: num(d.fontFamily, 5),
          textAlign: 'left', verticalAlign: 'top', x: x + (width - textWidth) / 2, y: y + (height - textHeight) / 2, seed: 2000 + i, versionNonce: 2000 + i,
        });
      }
    });
    return out;
  };
  const deliver = message => {
    const hook = window.__pizarraDeliver;
    if (typeof hook === 'function') hook(message);
  };
  const retire = (id, keep) => {
    const before = shown.get(id);
    if (!before) return;
    for (const elementId of before) if (!keep || !keep.has(elementId)) deliver({ type: 'element_deleted', elementId });
  };
  const applyDraft = (id, drafts) => {
    if (typeof window.__pizarraDeliver !== 'function') return;
    if (typeof id !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(id) || !Array.isArray(drafts) || drafts.length > 200) return;
    const elements = draftElements(id, drafts);
    const ids = new Set(elements.map(element => element.id));
    if (elements.length > 0) deliver({ type: 'elements_batch_created', elements });
    retire(id, ids);
    shown.set(id, ids);
  };
  const endDraft = id => {
    if (typeof id !== 'string') return;
    retire(id, null);
    shown.delete(id);
  };
  const clearDrafts = () => { for (const id of [...shown.keys()]) endDraft(id); };

  // ---- Theme and the "is drawing" indicator ----
  const LIGHT = '--pz-bg:#ffffff;--pz-fg:#1d1d1f;--pz-border:#d9d9de;--pz-dim:#6b6b76;--pz-accent:#6965db;--pz-field:#f5f5f7;';
  const DARK = '--pz-bg:#232329;--pz-fg:#e3e3e8;--pz-border:#3d3d46;--pz-dim:#9a9aa6;--pz-accent:#a8a5ff;--pz-field:#1c1c21;';
  const themed = [];
  const isDark = () => {
    if (document.querySelector('.excalidraw.theme--dark')) return true;
    if (document.querySelector('.excalidraw')) return false;
    return Boolean(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  };
  // Only the colour variables change with the theme: rewriting cssText would undo every
  // display the panel set since (the open panel, the drawing badge).
  const paint = () => {
    const vars = (isDark() ? DARK : LIGHT).split(';').filter(Boolean).map(pair => pair.split(':'));
    for (const node of themed) for (const [name, value] of vars) node.style.setProperty(name, value);
  };
  const themedBox = (node, css) => { node.style.cssText = css; themed.push(node); paint(); return node; };
  const whenBody = fn => { if (document.body) fn(); else document.addEventListener('DOMContentLoaded', fn); };
  if (typeof MutationObserver === 'function') {
    whenBody(() => new MutationObserver(paint).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'] }));
  }

  let badge = null;
  const showDrawing = (state, login) => {
    whenBody(() => {
      if (!badge) {
        badge = themedBox(h('div'), 'position:fixed;left:50%;bottom:8px;transform:translateX(-50%);z-index:2147483000;padding:4px 10px;border-radius:999px;background:var(--pz-bg);color:var(--pz-fg);border:1px solid var(--pz-border);font:12px system-ui,sans-serif;display:none;pointer-events:none');
        badge.setAttribute('data-pizarra-drawing', '');
        badge.setAttribute('data-pizarra-chrome', '');
        document.body.appendChild(badge);
      }
      const working = state === 'working';
      badge.textContent = (typeof login === 'string' && login ? login : 'The agent') + ' is drawing…';
      badge.style.display = working ? 'block' : 'none';
    });
  };

  // ---- Live events (every viewer) ----
  if (typeof window.EventSource === 'function') {
    const events = new window.EventSource(base + '/events');
    let dropped = false;
    const on = (type, fn) => events.addEventListener(type, event => {
      let data = null;
      try { data = JSON.parse(event.data); } catch { return; }
      if (data && typeof data === 'object') fn(data);
    });
    on('draft', data => applyDraft(data.id, data.elements));
    on('draft.end', data => endDraft(data.id));
    on('agent', data => showDrawing(data.state, data.login));
    // After a dropped connection the end of a draft may have been missed.
    events.addEventListener('error', () => { dropped = true; });
    events.addEventListener('open', () => { if (dropped) { dropped = false; clearDrafts(); } });
  }
  if (embedded) return;

  // ---- Panel ----
  const ERRORS = new Map([
    ['model_busy', 'The model is busy. Try again in a moment.'],
    ['reconnect', 'The connection dropped. Try again.'],
    ['provider_error', 'The model provider returned an error.'],
    ['busy', 'The agent is busy with another request on this board.'],
    ['turn_in_progress', 'A request is already running.'],
    ['not_connected', 'Connect your ChatGPT account first.'],
    ['engine_unavailable', 'The agent is not available right now.'],
    ['login_failed', 'Sign-in failed. Try again.'],
    ['rate_limited', 'Rate limit reached. Wait a bit and try again.'],
    ['turn_limit', 'The agent reached its limit for one request.'],
    ['model_unavailable', 'The model is not available for this account.'],
  ]);
  const errorText = code => (typeof code === 'string' && ERRORS.get(code)) || 'Something went wrong.';
  const STEPS = new Map([
    ['create_element', ['drawing', 'drawn']], ['batch_create_elements', ['drawing', 'drawn']], ['create_from_mermaid', ['drawing', 'drawn']],
    ['update_element', ['editing', 'edited']], ['delete_element', ['erasing', 'erased']],
    ['group_elements', ['arranging', 'arranged']], ['ungroup_elements', ['arranging', 'arranged']], ['align_elements', ['arranging', 'arranged']],
    ['distribute_elements', ['arranging', 'arranged']], ['duplicate_elements', ['arranging', 'arranged']],
  ]);
  const step = name => (typeof name === 'string' && STEPS.get(name)) || ['looking', 'looked'];
  const post = name => window.fetch(base + '/' + name, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const loadStatus = async () => {
    try {
      const response = await window.fetch(base + '/status', { credentials: 'same-origin' });
      return response.ok ? await response.json() : null;
    } catch {
      return null;
    }
  };

  const mount = () => {
    const root = themedBox(h('div'), 'position:fixed;right:12px;bottom:56px;z-index:2147483000;width:320px;max-width:calc(100vw - 24px);display:flex;flex-direction:column;align-items:flex-end;font:13px system-ui,sans-serif;color:var(--pz-fg)');
    root.setAttribute('data-pizarra-panel', '');
    root.setAttribute('data-pizarra-chrome', '');
    const body = themedBox(h('div'), 'display:none;width:100%;box-sizing:border-box;margin-bottom:6px;padding:8px;border-radius:10px;background:var(--pz-bg);border:1px solid var(--pz-border);box-shadow:0 2px 10px rgba(0,0,0,.18);flex-direction:column;gap:6px');
    const buttonCss = 'font:inherit;border:1px solid var(--pz-border);background:var(--pz-field);color:var(--pz-fg);border-radius:6px;padding:3px 10px;cursor:pointer';
    const linkButtonCss = 'font:inherit;border:0;background:none;color:var(--pz-accent);cursor:pointer;padding:0';
    const button = (label, css) => { const node = h('button', css || buttonCss, label); node.setAttribute('type', 'button'); return node; };
    const toggle = themedBox(button('Agent', ''), 'font:inherit;font-weight:600;border:1px solid var(--pz-border);background:var(--pz-bg);color:var(--pz-fg);border-radius:999px;padding:5px 14px;cursor:pointer;box-shadow:0 1px 4px rgba(0,0,0,.15)');
    toggle.setAttribute('aria-expanded', 'false');
    let open = false;
    toggle.addEventListener('click', () => {
      open = !open;
      body.style.display = open ? 'flex' : 'none';
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      paint();
    });

    // Signed out
    const signedOut = h('div', 'display:flex;flex-direction:column;gap:6px');
    signedOut.appendChild(h('div', '', 'Connect your ChatGPT account to ask the agent to draw on this board.'));
    const connect = button('Connect ChatGPT');
    const pending = h('div', 'display:none;flex-direction:column;gap:4px');
    const codeLine = h('div', 'font:600 18px ui-monospace,monospace;letter-spacing:1px');
    const linkLine = h('div');
    const waiting = h('div', 'color:var(--pz-dim)');
    pending.appendChild(codeLine);
    pending.appendChild(linkLine);
    pending.appendChild(waiting);
    const loginNote = h('div', 'color:#c0392b');
    signedOut.appendChild(connect);
    signedOut.appendChild(pending);
    signedOut.appendChild(loginNote);

    // Signed in
    const signedIn = h('div', 'display:none;flex-direction:column;gap:6px');
    const log = h('div', 'max-height:40vh;overflow-y:auto;display:flex;flex-direction:column;gap:4px');
    const input = themedBox(h('textarea'), 'font:inherit;box-sizing:border-box;width:100%;resize:vertical;border:1px solid var(--pz-border);border-radius:6px;padding:6px;background:var(--pz-field);color:var(--pz-fg)');
    input.setAttribute('rows', '2');
    input.setAttribute('placeholder', 'Ask the agent to draw… (Enter sends, Shift+Enter new line)');
    // Model and thinking: the account's models, each with the levels it supports.
    const choiceRow = h('div', 'display:none;gap:6px;align-items:center;font-size:12px');
    const selectCss = 'font:inherit;min-width:0;border:1px solid var(--pz-border);border-radius:6px;padding:2px 4px;background:var(--pz-field);color:var(--pz-fg)';
    const modelSelect = themedBox(h('select'), selectCss + ';flex:1');
    modelSelect.setAttribute('aria-label', 'Model');
    const thinkingSelect = themedBox(h('select'), selectCss);
    thinkingSelect.setAttribute('aria-label', 'Thinking');
    choiceRow.appendChild(modelSelect);
    choiceRow.appendChild(thinkingSelect);
    const actions = h('div', 'display:flex;gap:8px;align-items:center');
    const send = button('Send');
    const stop = button('Stop');
    stop.style.display = 'none';
    const reset = button('Reset', linkButtonCss);
    const signOut = button('Sign out', linkButtonCss);
    const spacer = h('span', 'flex:1');
    for (const node of [send, stop, spacer, reset, signOut]) actions.appendChild(node);
    signedIn.appendChild(log);
    signedIn.appendChild(choiceRow);
    signedIn.appendChild(input);
    signedIn.appendChild(actions);

    body.appendChild(signedOut);
    body.appendChild(signedIn);
    root.appendChild(body);
    root.appendChild(toggle);
    document.body.appendChild(root);

    let models = [];
    let modelsLoading = false;
    const readChoice = () => {
      try {
        const value = JSON.parse(window.localStorage.getItem(CHOICE_KEY) || '{}');
        return value && typeof value === 'object' ? value : {};
      } catch { return {}; }
    };
    const saveChoice = () => {
      try { window.localStorage.setItem(CHOICE_KEY, JSON.stringify({ model: modelSelect.value, thinking: thinkingSelect.value })); } catch { /* no storage: the choice lasts this page */ }
    };
    const option = (value, label) => { const node = h('option', '', label); node.value = value; return node; };
    /** Like pi: a level the model lacks becomes the nearest one above it, else below. */
    const clampLevel = (levels, wanted) => {
      if (levels.includes(wanted)) return wanted;
      const at = LEVELS.indexOf(wanted);
      if (at === -1) return levels.includes('medium') ? 'medium' : levels[levels.length - 1];
      return LEVELS.slice(at).find(level => levels.includes(level)) || LEVELS.slice(0, at).reverse().find(level => levels.includes(level)) || levels[0];
    };
    const fillThinking = wanted => {
      const model = models.find(m => m.id === modelSelect.value);
      const levels = model ? model.levels : ['off'];
      thinkingSelect.textContent = '';
      for (const level of levels) thinkingSelect.appendChild(option(level, level === 'off' ? 'No thinking' : 'Thinking: ' + level));
      thinkingSelect.value = clampLevel(levels, wanted);
      thinkingSelect.disabled = levels.length <= 1;
    };
    const showModels = list => {
      models = list;
      modelSelect.textContent = '';
      for (const model of models) modelSelect.appendChild(option(model.id, model.name));
      const saved = readChoice();
      modelSelect.value = models.some(m => m.id === saved.model) ? saved.model : models[0].id;
      fillThinking(typeof saved.thinking === 'string' ? saved.thinking : 'medium');
      choiceRow.style.display = 'flex';
    };
    const loadModels = async () => {
      if (models.length > 0 || modelsLoading) return;
      modelsLoading = true;
      try {
        const response = await post('models');
        const value = response.ok ? await response.json() : null;
        const list = value && Array.isArray(value.models) ? value.models.filter(m => m && typeof m.id === 'string' && MODEL.test(m.id) && typeof m.name === 'string'
          && Array.isArray(m.levels) && m.levels.length > 0 && m.levels.every(level => LEVELS.includes(level))) : [];
        if (list.length > 0) showModels(list);
      } catch { /* no list: turns use the account's first model */ } finally {
        modelsLoading = false;
      }
    };
    modelSelect.addEventListener('change', () => { fillThinking(thinkingSelect.value); saveChoice(); });
    thinkingSelect.addEventListener('change', saveChoice);

    const note = text => { log.appendChild(h('div', 'color:#c0392b;font-size:12px', text)); log.scrollTop = log.scrollHeight; };
    const showConnected = connected => {
      signedOut.style.display = connected ? 'none' : 'flex';
      signedIn.style.display = connected ? 'flex' : 'none';
      paint();
      if (connected) void loadModels();
    };

    // Device-code login
    let polls = 0;
    const showPending = value => {
      const userCode = value && typeof value.userCode === 'string' && CODE.test(value.userCode) ? value.userCode : null;
      if (!userCode) { pending.style.display = 'none'; return; }
      pending.style.display = 'flex';
      codeLine.textContent = userCode;
      linkLine.textContent = '';
      if (value.verificationUri === DEVICE_URI) {
        const link = h('a', 'color:var(--pz-accent)', 'Open the sign-in page');
        link.setAttribute('href', DEVICE_URI);
        link.setAttribute('target', '_blank');
        link.setAttribute('rel', 'noopener noreferrer');
        linkLine.appendChild(link);
        linkLine.appendChild(h('span', '', ' and enter this code.'));
      } else {
        linkLine.textContent = 'Enter this code on the OpenAI device sign-in page.';
      }
      waiting.textContent = 'Waiting for approval…';
    };
    const poll = () => {
      setTimeout(async () => {
        polls += 1;
        const status = await loadStatus();
        if (status && status.connected) { pending.style.display = 'none'; connect.style.display = ''; showConnected(true); return; }
        if (status && status.pending) { showPending(status.pending); if (polls < 300) poll(); return; }
        if (!status && polls < 300) { poll(); return; }
        pending.style.display = 'none';
        connect.style.display = '';
        loginNote.textContent = 'Sign-in did not complete. Try again.';
      }, 2000);
    };
    connect.addEventListener('click', async () => {
      loginNote.textContent = '';
      connect.style.display = 'none';
      try {
        const response = await post('login');
        if (!response.ok) throw new Error('login');
        const value = await response.json();
        if (!value || typeof value.userCode !== 'string' || !CODE.test(value.userCode)) throw new Error('login');
        showPending(value);
        polls = 0;
        poll();
      } catch {
        connect.style.display = '';
        loginNote.textContent = errorText('login_failed');
      }
    });

    // One turn
    let running = false;
    const setRunning = value => {
      running = value;
      send.style.display = value ? 'none' : '';
      stop.style.display = value ? '' : 'none';
    };
    const add = (css, text) => { const node = h('div', css, text); log.appendChild(node); log.scrollTop = log.scrollHeight; return node; };
    const handleTurn = () => {
      let current = null;
      const calls = new Map();
      return (event, data) => {
        if (event === 'delta' && typeof data.text === 'string') {
          if (!current || current.kind !== 'delta') current = { kind: 'delta', text: '', node: add('white-space:pre-wrap;overflow-wrap:anywhere') };
          current.text += data.text;
          current.node.textContent = current.text;
          log.scrollTop = log.scrollHeight;
        } else if (event === 'thinking' && typeof data.text === 'string') {
          if (!current || current.kind !== 'thinking') {
            const wrap = add('color:var(--pz-dim);font-size:12px');
            const head = button('Thinking…', linkButtonCss + ';color:var(--pz-dim)');
            const text = h('div', 'display:none;white-space:pre-wrap;overflow-wrap:anywhere;font-style:italic');
            head.addEventListener('click', () => { text.style.display = text.style.display === 'none' ? 'block' : 'none'; });
            wrap.appendChild(head);
            wrap.appendChild(text);
            current = { kind: 'thinking', text: '', node: text };
          }
          current.text += data.text;
          current.node.textContent = current.text;
        } else if (event === 'tool') {
          current = null;
          const [doing, did] = step(data.name);
          if (data.phase === 'start') calls.set(data.call, add('color:var(--pz-dim);font-size:12px', doing + '…'));
          else {
            const row = calls.get(data.call) || add('color:var(--pz-dim);font-size:12px');
            row.textContent = data.ok === true ? did : doing + ' failed';
          }
        } else if (event === 'settings' && models.some(m => m.id === data.model)) {
          // What the turn really runs with (allowlist, clamping); the saved choice stays.
          modelSelect.value = data.model;
          fillThinking(data.thinking);
        } else if (event === 'error') {
          current = null;
          note(errorText(data.code));
        } else if (event === 'done' && data.aborted === true) {
          current = null;
          add('color:var(--pz-dim);font-size:12px', 'Stopped.');
        }
      };
    };
    const readFrames = async (stream, onFrame) => {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const flush = frame => {
        let event = 'message';
        const lines = [];
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) lines.push(line.slice(5).replace(/^ /, ''));
        }
        if (lines.length === 0) return;
        try {
          const data = JSON.parse(lines.join('\n'));
          if (data && typeof data === 'object') onFrame(event, data);
        } catch { /* a frame that is not JSON is ignored */ }
      };
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n?/g, '\n');
        let at;
        while ((at = buffer.indexOf('\n\n')) !== -1) { flush(buffer.slice(0, at)); buffer = buffer.slice(at + 2); }
      }
      if (buffer.trim()) flush(buffer);
    };
    const refresh = async () => {
      const status = await loadStatus();
      if (status && status.enabled) showConnected(Boolean(status.connected));
    };
    const submit = async () => {
      const text = String(input.value || '').trim();
      if (!text || running) return;
      input.value = '';
      add('font-weight:600;white-space:pre-wrap;overflow-wrap:anywhere', text);
      setRunning(true);
      try {
        const response = await window.fetch(base + '/prompt', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(models.length > 0 ? { text, model: modelSelect.value, thinking: thinkingSelect.value } : { text }) });
        const type = (response.headers && response.headers.get('content-type')) || '';
        if (!response.ok || !/text\/event-stream/.test(type)) {
          let code = 'provider_error';
          try { const value = await response.json(); if (value && typeof value.error === 'string') code = value.error; } catch { /* keep the generic code */ }
          note(errorText(code));
          if (code === 'not_connected') showConnected(false);
        } else {
          await readFrames(response.body, handleTurn());
        }
      } catch {
        note(errorText('reconnect'));
      } finally {
        setRunning(false);
        void refresh();
      }
    };
    send.addEventListener('click', () => { void submit(); });
    input.addEventListener('keydown', event => {
      if (event.stopPropagation) event.stopPropagation();
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); void submit(); }
    });
    for (const type of ['keyup', 'keypress']) input.addEventListener(type, event => { if (event.stopPropagation) event.stopPropagation(); });
    stop.addEventListener('click', () => { void post('abort').catch(() => {}); });
    reset.addEventListener('click', async () => {
      try { await post('reset'); log.textContent = ''; } catch { note(errorText('reconnect')); }
    });
    signOut.addEventListener('click', async () => {
      try { await post('logout'); log.textContent = ''; showConnected(false); } catch { note(errorText('reconnect')); }
    });
    return { showConnected, showPending, poll };
  };

  const start = async () => {
    const status = await loadStatus();
    if (!status || status.enabled !== true) return;
    whenBody(() => {
      const panel = mount();
      panel.showConnected(Boolean(status.connected));
      if (!status.connected && status.pending) { panel.showPending(status.pending); panel.poll(); }
    });
  };
  void start();
})();
`;
