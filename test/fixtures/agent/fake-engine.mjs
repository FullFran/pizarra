// A stand-in for engine/main.mjs: speaks the gateway's line protocol (src/agent/protocol.ts) and
// does what the prompt text says, so tests can drive every path without pi or a network.
//   draw     narrate, preview a shape, run a tool, finish
//   garbage  send lines the gateway must drop, then finish
//   hang     never finish by itself; an abort ends the turn as aborted
//   die      preview a shape, then exit without finishing
//   badtools announce a tool outside the agent's list
//   choice   report the model and thinking level it was asked for (an unknown level clamps to high)
// `models` answers two models, the first without a name a browser could misread; a third, bogus one is dropped.
import { createInterface } from 'node:readline';

const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
const PREFIX = 'mcp__pizarra__';
const credential = n => ({ access: `fake-access-${n}`, refresh: `fake-refresh-${n}`, expires: Date.now() + 3_600_000, accountId: 'acct-fake' });
const rect = { type: 'rectangle', x: 10, y: 20, width: 100, height: 50, backgroundColor: '#a5d8ff', id: 'sneaky', customData: { x: 1 } };
let refreshes = 0;

function turn(text, message) {
  if (text === 'choice') {
    send({ type: 'settings', model: message.model ?? 'gpt-fake-a', thinking: message.thinking === 'max' ? 'high' : (message.thinking ?? 'medium') });
    send({ type: 'settings', model: 'not a model!', thinking: 'medium' });
    send({ type: 'done', aborted: false });
  } else if (text === 'draw') {
    send({ type: 'thinking', text: 'planning' });
    send({ type: 'delta', text: 'Drawing a box. ' });
    send({ type: 'draft', call: 1, elements: [rect] });
    send({ type: 'draft', call: 1, elements: [rect, { type: 'ellipse', x: 200, y: 20, width: 40, height: 40 }, { type: 'bogus', x: 1, y: 1 }] });
    send({ type: 'tool', call: 1, name: `${PREFIX}batch_create_elements`, phase: 'start', ok: true });
    send({ type: 'tool', call: 1, name: `${PREFIX}batch_create_elements`, phase: 'end', ok: true });
    send({ type: 'delta', text: 'Done.' });
    send({ type: 'done', aborted: false });
  } else if (text === 'garbage') {
    process.stdout.write('this is not json\n');
    send({ type: 'nope' });
    send({ type: 'delta', text: 123 });
    send({ type: 'tool', call: 1, name: 'clear_canvas', phase: 'end', ok: true });
    send({ type: 'tool', call: 2, name: `${PREFIX}clear_canvas`, phase: 'end', ok: true });
    send({ type: 'delta', text: 'still alive' });
    send({ type: 'done', aborted: false });
  } else if (text === 'die') {
    send({ type: 'draft', call: 7, elements: [rect] });
    setTimeout(() => process.exit(1), 20);
  } else if (text === 'badtools') {
    send({ type: 'session', tools: [`${PREFIX}clear_canvas`] });
  } else if (text !== 'hang') {
    send({ type: 'done', aborted: false });
  }
  // `hang`: nothing, until an abort.
}

createInterface({ input: process.stdin }).on('line', line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  switch (message.type) {
    case 'start':
      send({ type: 'ready', piVersion: '0.0.0' });
      send({ type: 'session', tools: [`${PREFIX}create_element`, `${PREFIX}batch_create_elements`, `${PREFIX}describe_scene`] });
      break;
    case 'login.start':
      send({ type: 'login.code', userCode: 'FAKE-1234' });
      setTimeout(() => send({ type: 'login.done', credential: credential(0) }), 30);
      break;
    case 'refresh':
      refreshes += 1;
      send({ type: 'refresh.done', id: message.id, credential: credential(refreshes) });
      break;
    case 'prompt': turn(message.text, message); break;
    case 'models':
      send({ type: 'models', models: [
        { id: 'gpt-fake-a', name: 'Fake A', levels: ['high', 'off', 'low'] },
        { id: 'gpt-fake-b', name: 'Fake\u0000B', levels: ['off'] },
      ] });
      break;
    case 'abort': send({ type: 'done', aborted: true }); break;
    case 'reset': send({ type: 'reset.done' }); break;
    case 'shutdown': process.exit(0); break;
    default: break;
  }
});
process.stdin.on('end', () => process.exit(0));
