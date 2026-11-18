import { TransportError } from './errors.ts';
import type { Connection, ConnectOptions, Transport, TransportTarget } from './types.ts';

/** Called with the server side of every connection made to a listening address. */
export type MemoryHandler = (connection: Connection) => void | Promise<void>;

interface Side {
  controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  readDone: boolean;
}

function endRead(side: Side, error?: TransportError): void {
  if (side.readDone) return;
  side.readDone = true;
  try {
    if (error) side.controller?.error(error);
    else side.controller?.close();
  } catch {
    // Already cancelled by the reader.
  }
}

/**
 * Create two connected in-memory connections. Bytes written to one are read from the other.
 * Chunks are copied, so callers may reuse their buffers after a write resolves.
 */
export function createConnectionPair(
  info: { host: string; port: number } = { host: 'memory', port: 0 },
): [Connection, Connection] {
  const sides: [Side, Side] = [
    { controller: undefined, readDone: false },
    { controller: undefined, readDone: false },
  ];
  const closed = [false, false];
  const openedAt = Date.now();

  const make = (self: 0 | 1): Connection => {
    const peer = self === 0 ? 1 : 0;
    const mine = sides[self];
    const theirs = sides[peer];
    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        mine.controller = controller;
      },
      cancel() {
        mine.readDone = true;
      },
    });
    const writable = new WritableStream<Uint8Array>({
      write(chunk) {
        if (closed[self] || theirs.readDone) {
          throw new TransportError('CLOSED', 'Memory connection is closed');
        }
        theirs.controller?.enqueue(chunk.slice());
      },
      close() {
        endRead(theirs);
      },
      abort() {
        endRead(theirs);
      },
    });
    return {
      readable,
      writable,
      info: {
        remoteHost: info.host,
        remotePort: info.port,
        remoteAddress: 'memory',
        openedAt,
      },
      async close() {
        if (closed[self]) return;
        closed[self] = true;
        endRead(theirs);
        endRead(mine);
      },
    };
  };
  return [make(0), make(1)];
}

function key(host: string, port: number): string {
  return `${host.toLowerCase()}:${port}`;
}

/**
 * An in-process transport for tests and examples. Register handlers with `listen()`;
 * `connect()` to a registered host and port hands the server side of a fresh connection
 * pair to the handler. Connecting anywhere else fails with CONNECT_REFUSED.
 */
export class MemoryTransport implements Transport {
  readonly name = 'memory';
  readonly #handlers = new Map<string, MemoryHandler>();
  readonly #open = new Set<Connection>();
  #closed = false;

  /** Accept connections to `host:port`. Returns a function that stops listening. */
  listen(host: string, port: number, handler: MemoryHandler): () => void {
    const k = key(host, port);
    if (this.#handlers.has(k)) throw new Error(`Already listening on ${host}:${port}`);
    this.#handlers.set(k, handler);
    return () => {
      if (this.#handlers.get(k) === handler) this.#handlers.delete(k);
    };
  }

  async connect(target: TransportTarget, options: ConnectOptions = {}): Promise<Connection> {
    if (this.#closed) throw new TransportError('CLOSED', 'Transport is closed');
    options.signal?.throwIfAborted();
    if (!Number.isInteger(target.port) || target.port < 1 || target.port > 65535) {
      throw new TransportError('BLOCKED_PORT', `Invalid port: ${String(target.port)}`);
    }
    const handler = this.#handlers.get(key(target.host, target.port));
    if (!handler) {
      throw new TransportError(
        'CONNECT_REFUSED',
        `Nothing is listening on ${target.host}:${target.port}`,
      );
    }
    const [client, server] = createConnectionPair({ host: target.host, port: target.port });
    const tracked: Connection = {
      readable: client.readable,
      writable: client.writable,
      info: client.info,
      close: async () => {
        this.#open.delete(tracked);
        await client.close();
      },
    };
    this.#open.add(tracked);
    options.signal?.addEventListener('abort', () => void tracked.close(), { once: true });
    queueMicrotask(() => {
      Promise.resolve()
        .then(() => handler(server))
        .catch(() => server.close());
    });
    return tracked;
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#handlers.clear();
    await Promise.all([...this.#open].map((c) => c.close()));
  }
}

/** A handler that writes back every chunk it receives. */
export const echoHandler: MemoryHandler = async (connection) => {
  await connection.readable.pipeTo(connection.writable).catch(() => connection.close());
};
