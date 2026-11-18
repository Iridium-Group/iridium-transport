import { createServer, type Server, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';

export interface TcpTestServer {
  port: number;
  close(): Promise<void>;
}

/** Start a TCP server on 127.0.0.1 with an ephemeral port. */
export async function startTcpServer(onSocket: (socket: Socket) => void): Promise<TcpTestServer> {
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    onSocket(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

/** A TCP server that writes back everything it receives. */
export function startEchoServer(): Promise<TcpTestServer> {
  return startTcpServer((socket) => socket.pipe(socket));
}

/** Find a port on 127.0.0.1 that nothing is listening on. */
export async function unusedPort(): Promise<number> {
  const server = await startTcpServer(() => undefined);
  const { port } = server;
  await server.close();
  return port;
}

/** Read everything from a readable stream until it ends. */
export async function readAll(readable: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of readable) chunks.push(chunk);
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/** Read from a reader until `length` bytes have arrived. */
export async function readExactly(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  length: number,
): Promise<Uint8Array> {
  const out = new Uint8Array(length);
  let offset = 0;
  while (offset < length) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`Stream ended after ${offset} of ${length} bytes`);
    out.set(value.subarray(0, length - offset), offset);
    offset += value.byteLength;
  }
  return out;
}
