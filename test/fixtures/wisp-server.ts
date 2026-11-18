/**
 * A minimal Wisp v1 server for tests and the local example. TCP streams only.
 * It forwards to real TCP sockets with node:net, so point it at a local server.
 * Not hardened and not for production use.
 */
import { createServer, type Server } from 'node:http';
import { connect, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import {
  CloseReason,
  PacketType,
  decodePacket,
  encodeClose,
  encodeContinue,
  encodeData,
  type WispPacket,
} from '../../src/wisp/packets.ts';
import { acceptWebSocket, type TestWebSocket } from './websocket.ts';

export interface WispTestServerOptions {
  /** Packets the server buffers per stream (sent in CONTINUE). Default 32. */
  bufferSize?: number;
  /** Ports the server refuses with CLOSE 0x48. */
  blockedPorts?: number[];
  /** Never send the initial CONTINUE, so clients time out. */
  silent?: boolean;
  /** Do not send CONTINUE after the buffer is used; the test sends them with sendContinue(). */
  manualContinue?: boolean;
  /** Rewrite the hostname clients ask for before connecting (for example "echo.test" to "127.0.0.1"). */
  resolveHost?: (host: string) => string;
}

export interface WispTestServer {
  url: string;
  /** Every packet received from clients, in order. */
  received: WispPacket[];
  /** Highest number of DATA packets received on one stream without a CONTINUE in between. */
  maxUnacknowledged: number;
  sendContinue(streamId: number, bufferRemaining: number): void;
  sendClose(streamId: number, reason: number): void;
  close(): Promise<void>;
}

interface ServerStream {
  socket: Socket;
  sinceContinue: number;
}

export async function startWispServer(
  options: WispTestServerOptions = {},
): Promise<WispTestServer> {
  const bufferSize = options.bufferSize ?? 32;
  const blocked = new Set(options.blockedPorts ?? []);
  const clients = new Set<TestWebSocket>();
  const state: WispTestServer = {
    url: '',
    received: [],
    maxUnacknowledged: 0,
    sendContinue(streamId, n) {
      for (const ws of clients) ws.send(encodeContinue(streamId, n));
    },
    sendClose(streamId, reason) {
      for (const ws of clients) ws.send(encodeClose(streamId, reason));
    },
    close: async () => undefined,
  };

  const server: Server = createServer((_req, res) => {
    res.writeHead(426, { 'content-type': 'text/plain' });
    res.end('WebSocket upgrade required\n');
  });

  server.on('upgrade', (req, rawSocket) => {
    const ws = acceptWebSocket(req, rawSocket);
    if (!ws) return;
    clients.add(ws);
    const streams = new Map<number, ServerStream>();
    ws.onClose(() => {
      clients.delete(ws);
      for (const s of streams.values()) s.socket.destroy();
      streams.clear();
    });
    if (!options.silent) ws.send(encodeContinue(0, bufferSize));

    ws.onMessage((data) => {
      let packet: WispPacket;
      try {
        packet = decodePacket(data);
      } catch {
        ws.close(1002);
        return;
      }
      state.received.push(packet);
      if ('unknown' in packet) return;

      switch (packet.type) {
        case PacketType.CONNECT: {
          const id = packet.streamId;
          if (blocked.has(packet.port)) {
            ws.send(encodeClose(id, CloseReason.BLOCKED));
            return;
          }
          const host = options.resolveHost ? options.resolveHost(packet.hostname) : packet.hostname;
          const socket = connect({ host, port: packet.port });
          const stream: ServerStream = { socket, sinceContinue: 0 };
          streams.set(id, stream);
          socket.on('data', (chunk: Buffer) => ws.send(encodeData(id, new Uint8Array(chunk))));
          socket.on('error', (err: NodeJS.ErrnoException) => {
            if (!streams.has(id)) return;
            streams.delete(id);
            ws.send(
              encodeClose(
                id,
                err.code === 'ECONNREFUSED'
                  ? CloseReason.CONNECTION_REFUSED
                  : CloseReason.NETWORK_ERROR,
              ),
            );
          });
          socket.on('end', () => {
            if (!streams.has(id)) return;
            streams.delete(id);
            ws.send(encodeClose(id, CloseReason.VOLUNTARY));
          });
          return;
        }
        case PacketType.DATA: {
          const stream = streams.get(packet.streamId);
          if (!stream) return;
          stream.sinceContinue += 1;
          state.maxUnacknowledged = Math.max(state.maxUnacknowledged, stream.sinceContinue);
          stream.socket.write(packet.payload.slice());
          if (!options.manualContinue && stream.sinceContinue >= bufferSize) {
            stream.sinceContinue = 0;
            ws.send(encodeContinue(packet.streamId, bufferSize));
          }
          return;
        }
        case PacketType.CLOSE: {
          const stream = streams.get(packet.streamId);
          if (!stream) return;
          streams.delete(packet.streamId);
          stream.socket.destroy();
          return;
        }
        default:
          return;
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  state.url = `ws://127.0.0.1:${port}/wisp/`;
  state.close = () =>
    new Promise<void>((resolve) => {
      for (const ws of clients) ws.close(1001);
      server.close(() => resolve());
      server.closeAllConnections();
    });
  return state;
}
