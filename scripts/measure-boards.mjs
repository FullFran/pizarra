#!/usr/bin/env node
// Measures memory per open board (docs/multiuser.md, issue #11): starts a
// gateway, opens N boards (one REST write and one MCP call each, plus an
// open WebSocket), and prints the resident set size of every board canvas
// and of the gateway before and after. Not part of `npm test`.
// Usage: node scripts/measure-boards.mjs [boards=5]
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { childPids, killAll, mcpCall, pssMiB, request, rssMiB, sleep, startGateway, wsOpen } from './lib/harness.mjs';

const count = Number(process.argv[2] ?? 5);
const scratch = mkdtempSync(join(tmpdir(), 'pizarra-measure-'));
const gateway = await startGateway(scratch, { EXCALIDRAW_DATA_DIR: join(scratch, 'data'), MAX_OPEN_BOARDS: String(count + 1) });
const { base } = gateway;
await sleep(1000);
const gatewayBefore = rssMiB(gateway.child.pid);
const [mainPid] = childPids(gateway.child.pid);
const mainRss = rssMiB(mainPid);
const sockets = [];
for (let i = 0; i < count; i += 1) {
  const id = `m${i}`;
  await request(base, { method: 'POST', path: '/boards', json: { id } });
  await request(base, { method: 'POST', path: `/b/${id}/api/elements`, json: { id: `e${i}`, type: 'rectangle', x: 0, y: 0, width: 10, height: 10 } });
  await mcpCall(base, `/b/${id}/mcp`, 'describe_scene', {});
  sockets.push((await wsOpen(`ws://127.0.0.1:${gateway.port}/b/${id}/`, {}, { keep: true })).socket);
}
await sleep(2000);
const boardPids = childPids(gateway.child.pid).filter(pid => pid !== mainPid);
const boards = boardPids.map(rssMiB);
const boardsPss = boardPids.map(pssMiB);
const gatewayAfter = rssMiB(gateway.child.pid);
const average = boards.reduce((a, b) => a + b, 0) / boards.length;
console.log(JSON.stringify({
  node: process.version,
  boards: count,
  canvasRssMiB: { main: mainRss, perBoard: boards, average: Math.round(average * 10) / 10, max: Math.max(...boards) },
  canvasPssMiB: { perBoard: boardsPss, average: Math.round((boardsPss.reduce((a, b) => a + b, 0) / boardsPss.length) * 10) / 10 },
  gatewayRssMiB: { withMainOnly: gatewayBefore, afterOpeningBoards: gatewayAfter, perBoardMcp: Math.round(((gatewayAfter - gatewayBefore) / count) * 10) / 10 }
}, null, 2));
for (const socket of sockets) socket?.close();
await gateway.stop();
killAll();
rmSync(scratch, { recursive: true, force: true });
