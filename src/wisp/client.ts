import { TransportError } from '../errors.ts';
import type { Connection, ConnectOptions, Transport, TransportTarget } from '../types.ts';
import {
  CloseReason,
  PacketType,
  StreamType,
  closeReasonName,
  closeReasonToErrorCode,
  decodePacket,
  encodeClose,
  encodeConnect,
  encodeData,
} from './packets.ts';

export const DEFAULT_WISP_CONNECT_TIMEOUT_MS = 10_000;

/** The parts of the WHATWG WebSocket this client uses. */
export interface WebSocketLike {
  binaryType: string;
  readonly readyState: number;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  addEventListener(
    type: 'close',
    listener: (event: { code: number; reason: string }) => void,
  ): void;
  addEventListener(type: 'error', listener: (event: unknown) => void): void;
}

export type WebSocketConstructor = new (
  url: string,
  protocols?: string | string[],
) => WebSocketLike;

export interface WispClientTransportOptions {
  /** WebSocket URL of the Wisp server. Per the protocol it should end with "/". */
  url: string;
  /** WebSocket implementation. Defaults to the global `WebSocket` (browsers, Node 22+). */
  WebSocket?: WebSocketConstructor;
  /** How long to wait for the WebSocket to open and the server's initial CONTINUE. Default 10000 ms. */
  connectTimeoutMs?: number;
}

/** A connection opened over Wisp. Adds the close reason the server or client used. */
export interface WispConnection extends Connection {
  readonly streamId: number;
  /** Resolves with the Wisp close reason once the stream is closed by either side. */
  readonly closed: Promise<number>;
}

interface StreamState {
  id: number;
  credit: number;
  creditWaiters: Array<() => void>;
  controller: ReadableStreamDefaultController<Uint8Array>;
  closed: boolean;
  resolveClosed: (reason: number) => void;
  error: TransportError | undefined;
}

interface Session {
  socket: WebSocketLike;
  initialBuffer: number;
  streams: Map<number, StreamState>;
  closed: boolean;
}

const WS_OPEN = 1;

function randomStreamId(): number {
  const buf = new Uint32Array(1);
  globalThis.crypto.getRandomValues(buf);
  return buf[0] ?? 0;
}

function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data))
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

/**
 * A Wisp v1 client. Multiplexes many TCP streams over one WebSocket, opened lazily on the
 * first `connect()` and reopened on the next `connect()` if it drops.
 *
 * Flow control: the server's CONTINUE packets grant a number of DATA packets per stream;
 * writes wait while that credit is zero. Server-to-client data has no flow control in Wisp v1,
 * so incoming data is queued in the readable stream until it is read.
 *
 * TLS is not performed by this class. Targets with `tls: true` are rejected with a PROTOCOL error;
 * layer TLS above the connection if you need it.
 */
export class WispClientTransport implements Transport {
  readonly name = 'wisp';
  readonly url: string;
  readonly connectTimeoutMs: number;
  readonly #WebSocket: WebSocketConstructor;
  #session: Promise<Session> | undefined;
  #closed = false;

  constructor(options: WispClientTransportOptions) {
    if (!options || typeof options.url !== 'string' || options.url.length === 0) {
      throw new TypeError('WispClientTransport requires a url');
    }
    const ctor =
      options.WebSocket ??
      (globalThis as { WebSocket?: WebSocketConstructor }).WebSocket ??
      undefined;
    if (!ctor) throw new TypeError('No WebSocket implementation available');
    this.url = options.url;
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_WISP_CONNECT_TIMEOUT_MS;
    this.#WebSocket = ctor;
  }

  #openSession(timeoutMs: number, signal?: AbortSignal): Promise<Session> {
    return new Promise<Session>((resolve, reject) => {
      let settled = false;
      let socket: WebSocketLike;
      try {
        socket = new this.#WebSocket(this.url);
      } catch (cause) {
        reject(new TransportError('CONNECT_REFUSED', `Could not open ${this.url}`, { cause }));
        return;
      }
      socket.binaryType = 'arraybuffer';
      const session: Session = { socket, initialBuffer: 0, streams: new Map(), closed: false };

      const fail = (err: TransportError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        session.closed = true;
        try {
          socket.close();
        } catch {
          // Closing a socket that never opened can throw in some implementations.
        }
        reject(err);
      };
      const onAbort = () =>
        fail(new TransportError('CLOSED', 'Connection attempt aborted', { cause: signal?.reason }));
      const timer = setTimeout(
        () =>
          fail(
            new TransportError(
              'CONNECT_TIMEOUT',
              `Wisp server did not become ready within ${timeoutMs} ms`,
            ),
          ),
        timeoutMs,
      );
      signal?.addEventListener('abort', onAbort, { once: true });

      socket.addEventListener('message', (event) => {
        const bytes = toBytes(event.data);
        if (!bytes) {
          this.#teardown(session, new TransportError('PROTOCOL', 'Wisp server sent a text frame'));
          fail(new TransportError('PROTOCOL', 'Wisp server sent a text frame'));
          return;
        }
        let packet;
        try {
          packet = decodePacket(bytes);
        } catch (err) {
          const error = err as TransportError;
          this.#teardown(session, error);
          fail(error);
          return;
        }
        if (!settled) {
          // The first packet must be the stream-0 CONTINUE carrying the default buffer size.
          if (
            !('unknown' in packet) &&
            packet.type === PacketType.CONTINUE &&
            packet.streamId === 0
          ) {
            session.initialBuffer = packet.bufferRemaining;
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            resolve(session);
          } else {
            const error = new TransportError(
              'PROTOCOL',
              'Expected an initial CONTINUE packet for stream 0',
            );
            this.#teardown(session, error);
            fail(error);
          }
          return;
        }
        this.#handlePacket(session, packet);
      });
      socket.addEventListener('close', (event) => {
        const error = new TransportError(
          'CLOSED',
          `Wisp WebSocket closed (code ${event.code}${event.reason ? `: ${event.reason}` : ''})`,
        );
        this.#teardown(session, error);
        fail(
          new TransportError('CONNECT_REFUSED', `Wisp server at ${this.url} closed the connection`),
        );
      });
      socket.addEventListener('error', () => {
        fail(new TransportError('CONNECT_REFUSED', `Could not connect to ${this.url}`));
      });
    });
  }

  #handlePacket(session: Session, packet: ReturnType<typeof decodePacket>): void {
    if ('unknown' in packet) return;
    const stream = session.streams.get(packet.streamId);
    if (!stream) return;
    switch (packet.type) {
      case PacketType.DATA:
        if (!stream.closed) stream.controller.enqueue(packet.payload.slice());
        return;
      case PacketType.CONTINUE: {
        stream.credit = packet.bufferRemaining;
        const waiters = stream.creditWaiters.splice(0);
        for (const wake of waiters) wake();
        return;
      }
      case PacketType.CLOSE: {
        const error =
          packet.reason === CloseReason.VOLUNTARY
            ? undefined
            : new TransportError(
                closeReasonToErrorCode(packet.reason),
                `Wisp stream closed by server: ${closeReasonName(packet.reason)}`,
              );
        this.#finishStream(session, stream, packet.reason, error);
        return;
      }
      case PacketType.CONNECT:
        // Servers do not open streams in Wisp v1.
        return;
    }
  }

  #finishStream(
    session: Session,
    stream: StreamState,
    reason: number,
    error: TransportError | undefined,
  ): void {
    if (stream.closed) return;
    stream.closed = true;
    stream.error = error ?? new TransportError('CLOSED', 'Wisp stream is closed');
    session.streams.delete(stream.id);
    try {
      if (error) stream.controller.error(error);
      else stream.controller.close();
    } catch {
      // The readable may already be cancelled.
    }
    const waiters = stream.creditWaiters.splice(0);
    for (const wake of waiters) wake();
    stream.resolveClosed(reason);
  }

  #teardown(session: Session, error: TransportError): void {
    if (session.closed && session.streams.size === 0) return;
    session.closed = true;
    for (const stream of [...session.streams.values()]) {
      this.#finishStream(session, stream, CloseReason.NETWORK_ERROR, error);
    }
  }

  async #getSession(timeoutMs: number, signal?: AbortSignal): Promise<Session> {
    if (this.#session) {
      try {
        const existing = await this.#session;
        if (!existing.closed && existing.socket.readyState === WS_OPEN) return existing;
      } catch {
        // A failed earlier attempt; open a fresh session below.
      }
    }
    const attempt = this.#openSession(timeoutMs, signal);
    this.#session = attempt;
    attempt.catch(() => {
      if (this.#session === attempt) this.#session = undefined;
    });
    return attempt;
  }

  async connect(target: TransportTarget, options: ConnectOptions = {}): Promise<WispConnection> {
    if (this.#closed) throw new TransportError('CLOSED', 'Transport is closed');
    options.signal?.throwIfAborted();
    if (target.tls) {
      throw new TransportError(
        'PROTOCOL',
        'WispClientTransport does not perform TLS; layer TLS above the connection',
      );
    }
    if (!Number.isInteger(target.port) || target.port < 1 || target.port > 65535) {
      throw new TransportError('BLOCKED_PORT', `Invalid port: ${String(target.port)}`);
    }
    const host = target.host.replace(/^\[(.*)\]$/, '$1');
    if (host.length === 0) throw new TransportError('CONNECT_REFUSED', 'Empty host');

    const session = await this.#getSession(
      options.timeoutMs ?? this.connectTimeoutMs,
      options.signal,
    );
    if (this.#closed) throw new TransportError('CLOSED', 'Transport is closed');

    let id = randomStreamId();
    while (id === 0 || session.streams.has(id)) id = randomStreamId();

    let resolveClosed!: (reason: number) => void;
    const closed = new Promise<number>((resolve) => (resolveClosed = resolve));
    let state!: StreamState;

    const readable = new ReadableStream<Uint8Array>({
      start: (controller) => {
        state = {
          id,
          credit: session.initialBuffer,
          creditWaiters: [],
          controller,
          closed: false,
          resolveClosed,
          error: undefined,
        };
      },
      cancel: () => {
        this.#closeStream(session, state, CloseReason.VOLUNTARY);
      },
    });
    session.streams.set(id, state);

    const send = (bytes: Uint8Array) => {
      if (session.closed || session.socket.readyState !== WS_OPEN) {
        throw new TransportError('CLOSED', 'Wisp WebSocket is not open');
      }
      session.socket.send(bytes);
    };

    send(encodeConnect(id, host, target.port, StreamType.TCP));

    const writable = new WritableStream<Uint8Array>({
      write: async (chunk) => {
        while (!state.closed && state.credit <= 0) {
          await new Promise<void>((wake) => state.creditWaiters.push(wake));
        }
        if (state.closed) throw state.error ?? new TransportError('CLOSED', 'Stream is closed');
        state.credit -= 1;
        send(encodeData(id, chunk));
      },
      // Wisp v1 has no half-close. Closing the writable only stops further writes; the stream
      // stays open for reading until either side sends CLOSE.
      close: () => undefined,
      abort: () => {
        this.#closeStream(session, state, CloseReason.VOLUNTARY);
      },
    });

    const onAbort = () => this.#closeStream(session, state, CloseReason.VOLUNTARY);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    void closed.then(() => options.signal?.removeEventListener('abort', onAbort));

    return {
      streamId: id,
      readable,
      writable,
      closed,
      info: { remoteHost: target.host, remotePort: target.port, openedAt: Date.now() },
      close: async () => {
        this.#closeStream(session, state, CloseReason.VOLUNTARY);
        await closed;
      },
    };
  }

  #closeStream(session: Session, stream: StreamState, reason: number): void {
    if (stream.closed) return;
    if (!session.closed && session.socket.readyState === WS_OPEN) {
      session.socket.send(encodeClose(stream.id, reason));
    }
    this.#finishStream(session, stream, reason, undefined);
  }

  async close(): Promise<void> {
    this.#closed = true;
    const pending = this.#session;
    this.#session = undefined;
    if (!pending) return;
    let session: Session;
    try {
      session = await pending;
    } catch {
      return;
    }
    for (const stream of [...session.streams.values()]) {
      this.#closeStream(session, stream, CloseReason.VOLUNTARY);
    }
    session.closed = true;
    try {
      session.socket.close(1000, 'client closed');
    } catch {
      // Already closed.
    }
  }
}
