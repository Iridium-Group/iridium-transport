/** Where a transport should open a connection. */
export interface TransportTarget {
  /** Hostname, IPv4 literal, or IPv6 literal (brackets are accepted). */
  host: string;
  /** TCP port, 1 to 65535. */
  port: number;
  /** Wrap the connection in TLS. Only supported by transports that can do TLS themselves. */
  tls?: boolean;
}

export interface ConnectOptions {
  /** Abort the connection attempt. Aborting after the connection is open closes it. */
  signal?: AbortSignal;
  /** Override the transport's default connect timeout for this call, in milliseconds. */
  timeoutMs?: number;
}

export interface ConnectionInfo {
  /** The host the caller asked for. */
  remoteHost: string;
  /** The port the caller asked for. */
  remotePort: number;
  /** The address the connection was actually opened to, when the transport knows it. */
  remoteAddress?: string;
  /** Milliseconds since the Unix epoch when the connection was opened. */
  openedAt: number;
}

/** A bidirectional byte stream. */
export interface Connection {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  readonly info: ConnectionInfo;
  /** Close both directions. Safe to call more than once. */
  close(): Promise<void>;
}

export interface Transport {
  readonly name: string;
  connect(target: TransportTarget, options?: ConnectOptions): Promise<Connection>;
  /** Close the transport and every connection it opened. Safe to call more than once. */
  close(): Promise<void>;
}
