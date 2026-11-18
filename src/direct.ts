import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect, type ConnectionOptions as TlsConnectionOptions } from 'node:tls';
import { ipVersion } from './address.ts';
import { TransportError } from './errors.ts';
import { socketToStreams } from './node-streams.ts';
import { AddressPolicy } from './policy.ts';
import type { Connection, ConnectOptions, Transport, TransportTarget } from './types.ts';

export const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

export interface DirectTransportOptions {
  /** Address and port policy. Defaults to `new AddressPolicy()` (private addresses and ports 25/465/587 blocked). */
  policy?: AddressPolicy;
  /** How long to wait for TCP (and TLS, when requested) to be established. Default 10000 ms. */
  connectTimeoutMs?: number;
  /** Extra TLS options for `tls: true` targets, such as `ca` or `rejectUnauthorized`. */
  tls?: Pick<TlsConnectionOptions, 'ca' | 'rejectUnauthorized' | 'ALPNProtocols' | 'minVersion'>;
}

const REFUSED_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EHOSTDOWN',
  'ENETDOWN',
]);

function connectError(cause: unknown, target: TransportTarget): TransportError {
  const code = (cause as { code?: string } | null)?.code;
  const where = `${target.host}:${target.port}`;
  if (code === 'ETIMEDOUT') {
    return new TransportError('CONNECT_TIMEOUT', `Timed out connecting to ${where}`, { cause });
  }
  if (code && REFUSED_CODES.has(code)) {
    return new TransportError('CONNECT_REFUSED', `Could not connect to ${where} (${code})`, {
      cause,
    });
  }
  return new TransportError('CONNECT_REFUSED', `Could not connect to ${where}`, { cause });
}

/**
 * Opens real TCP or TLS connections from Node. Every target passes through the address
 * policy first, and the socket is opened to the validated address, never to the hostname.
 */
export class DirectTransport implements Transport {
  readonly name = 'direct';
  readonly policy: AddressPolicy;
  readonly connectTimeoutMs: number;
  readonly #tls: DirectTransportOptions['tls'];
  readonly #sockets = new Set<Socket>();
  #closed = false;

  constructor(options: DirectTransportOptions = {}) {
    this.policy = options.policy ?? new AddressPolicy();
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.#tls = options.tls;
  }

  async connect(target: TransportTarget, options: ConnectOptions = {}): Promise<Connection> {
    if (this.#closed) throw new TransportError('CLOSED', 'Transport is closed');
    options.signal?.throwIfAborted();

    const resolved = await this.policy.check(target);
    const timeoutMs = options.timeoutMs ?? this.connectTimeoutMs;
    const host = target.host.replace(/^\[(.*)\]$/, '$1');

    const socket = await new Promise<Socket>((resolve, reject) => {
      let settled = false;
      const sock: Socket = target.tls
        ? tlsConnect({
            ...this.#tls,
            host: resolved.address,
            port: target.port,
            // SNI and certificate checks use the name the caller asked for, not the pinned address.
            // IP literals get no SNI and are verified against the IP itself.
            servername: ipVersion(host) === 0 ? host : undefined,
          })
        : netConnect({ host: resolved.address, port: target.port });
      const finish = (err?: TransportError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        sock.off('error', onError);
        if (err) {
          sock.destroy();
          reject(err);
        } else {
          resolve(sock);
        }
      };
      const onError = (cause: unknown) => finish(connectError(cause, target));
      const onAbort = () =>
        finish(
          new TransportError('CLOSED', 'Connection attempt aborted', {
            cause: options.signal?.reason,
          }),
        );
      const timer = setTimeout(
        () =>
          finish(
            new TransportError(
              'CONNECT_TIMEOUT',
              `Timed out after ${timeoutMs} ms connecting to ${target.host}:${target.port}`,
            ),
          ),
        timeoutMs,
      );

      sock.once(target.tls ? 'secureConnect' : 'connect', () => finish());
      sock.on('error', onError);
      options.signal?.addEventListener('abort', onAbort, { once: true });
    });

    if (this.#closed) {
      socket.destroy();
      throw new TransportError('CLOSED', 'Transport is closed');
    }

    this.#sockets.add(socket);
    socket.once('close', () => this.#sockets.delete(socket));
    socket.on('error', () => {
      // Errors after connect are surfaced through the streams.
    });

    const { readable, writable } = socketToStreams(socket);
    const onAbortAfterOpen = () => socket.destroy();
    options.signal?.addEventListener('abort', onAbortAfterOpen, { once: true });
    socket.once('close', () => options.signal?.removeEventListener('abort', onAbortAfterOpen));

    return {
      readable,
      writable,
      info: {
        remoteHost: target.host,
        remotePort: target.port,
        remoteAddress: resolved.address,
        openedAt: Date.now(),
      },
      close: () =>
        new Promise<void>((resolve) => {
          if (socket.destroyed) {
            resolve();
            return;
          }
          socket.once('close', () => resolve());
          socket.destroy();
        }),
    };
  }

  async close(): Promise<void> {
    this.#closed = true;
    const pending = [...this.#sockets].map(
      (socket) =>
        new Promise<void>((resolve) => {
          if (socket.destroyed) return resolve();
          socket.once('close', () => resolve());
          socket.destroy();
        }),
    );
    await Promise.all(pending);
  }
}
