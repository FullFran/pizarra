import type { Duplex } from 'node:stream';

/** Largest frame a viewer's browser may send (control frames are at most 125 bytes; data frames are dropped anyway). */
const MAX_FRAME = 1 << 20;

/**
 * Browser-to-canvas half of a viewer's WebSocket: control frames (close,
 * ping, pong) pass, every data frame (text, binary, continuation) is
 * dropped, so nothing a viewer's page sends can change the board, whatever
 * the upstream would do with it. Frames are parsed (RFC 6455 §5.2), not
 * guessed: a malformed or oversized frame closes the connection.
 */
export function dropDataFrames(client: Duplex, upstream: Duplex): void {
  let buffer: Buffer = Buffer.alloc(0);
  const fail = () => { client.destroy(); upstream.destroy(); };
  client.on('data', (chunk: Buffer) => {
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 2) return;
      const opcode = buffer[0]! & 0x0f;
      const masked = (buffer[1]! & 0x80) !== 0;
      let length = buffer[1]! & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        const big = buffer.readBigUInt64BE(2);
        if (big > BigInt(MAX_FRAME)) return fail();
        length = Number(big);
        offset = 10;
      }
      if (length > MAX_FRAME || !masked) return fail();
      const total = offset + 4 + length;
      if (buffer.length < total) return;
      const frame = buffer.subarray(0, total);
      buffer = buffer.subarray(total);
      if (opcode >= 0x8) upstream.write(Buffer.from(frame));
      else if (opcode > 0x2) return fail();
    }
  });
  client.on('end', () => upstream.end());
}
