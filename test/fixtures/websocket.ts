/**
 * A minimal RFC 6455 WebSocket server endpoint for tests. Handles the upgrade handshake,
 * masked client frames, fragmentation, ping/pong and close. Binary messages only matter here.
 * Not for production use.
 */
import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export interface TestWebSocket {
  send(data: Uint8Array): void;
  close(code?: number): void;
  onMessage(handler: (data: Uint8Array, binary: boolean) => void): void;
  onClose(handler: () => void): void;
  readonly closed: boolean;
}

export function acceptWebSocket(req: IncomingMessage, socket: Duplex): TestWebSocket | null {
  const key = req.headers['sec-websocket-key'];
  if (typeof key !== 'string' || req.headers.upgrade?.toLowerCase() !== 'websocket') {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    return null;
  }
  const accept = createHash('sha1')
    .update(key + GUID)
    .digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );

  let buffer = Buffer.alloc(0);
  let fragments: Buffer[] = [];
  let fragmentOpcode = 0;
  let closed = false;
  const messageHandlers: Array<(data: Uint8Array, binary: boolean) => void> = [];
  const closeHandlers: Array<() => void> = [];

  const writeFrame = (opcode: number, payload: Uint8Array) => {
    if (socket.destroyed) return;
    const len = payload.byteLength;
    let head: Buffer;
    if (len < 126) {
      head = Buffer.from([0x80 | opcode, len]);
    } else if (len < 65536) {
      head = Buffer.alloc(4);
      head[0] = 0x80 | opcode;
      head[1] = 126;
      head.writeUInt16BE(len, 2);
    } else {
      head = Buffer.alloc(10);
      head[0] = 0x80 | opcode;
      head[1] = 127;
      head.writeBigUInt64BE(BigInt(len), 2);
    }
    socket.write(Buffer.concat([head, payload]));
  };

  const finish = () => {
    if (closed) return;
    closed = true;
    for (const h of closeHandlers) h();
  };

  const parse = () => {
    for (;;) {
      if (buffer.length < 2) return;
      const b0 = buffer[0] as number;
      const b1 = buffer[1] as number;
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (buffer.length < 4) return;
        len = buffer.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (buffer.length < 10) return;
        len = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }
      const maskLen = masked ? 4 : 0;
      if (buffer.length < offset + maskLen + len) return;
      const mask = buffer.subarray(offset, offset + maskLen);
      const payload = Buffer.from(buffer.subarray(offset + maskLen, offset + maskLen + len));
      if (masked) for (let i = 0; i < payload.length; i++) payload[i]! ^= mask[i % 4]!;
      buffer = buffer.subarray(offset + maskLen + len);

      if (opcode === 0x8) {
        writeFrame(0x8, payload.subarray(0, 2));
        socket.end();
        finish();
        return;
      }
      if (opcode === 0x9) {
        writeFrame(0xa, payload);
        continue;
      }
      if (opcode === 0xa) continue;
      if (opcode === 0x0) {
        fragments.push(payload);
      } else {
        fragmentOpcode = opcode;
        fragments = [payload];
      }
      if (fin) {
        const data = Buffer.concat(fragments);
        fragments = [];
        for (const h of messageHandlers) h(new Uint8Array(data), fragmentOpcode === 0x2);
      }
    }
  };

  socket.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    parse();
  });
  socket.on('close', finish);
  socket.on('error', finish);

  return {
    send(data) {
      writeFrame(0x2, data);
    },
    close(code = 1000) {
      const payload = Buffer.alloc(2);
      payload.writeUInt16BE(code, 0);
      writeFrame(0x8, payload);
      socket.end();
      finish();
    },
    onMessage(handler) {
      messageHandlers.push(handler);
    },
    onClose(handler) {
      closeHandlers.push(handler);
    },
    get closed() {
      return closed;
    },
  };
}
