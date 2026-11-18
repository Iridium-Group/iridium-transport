/**
 * Error codes shared by every transport in this package.
 *
 * - `BLOCKED_ADDRESS`: the target resolved to an address the policy (or a Wisp server) refuses.
 * - `BLOCKED_PORT`: the target port is invalid, on the blocked list, or not on the allowed list.
 * - `CONNECT_TIMEOUT`: the connection was not established within the configured time.
 * - `CONNECT_REFUSED`: the target could not be reached (refused, unreachable, or did not resolve).
 * - `CLOSED`: the connection or transport was closed, or closed unexpectedly.
 * - `PROTOCOL`: a peer sent data that does not follow the expected protocol, or a feature is unsupported.
 */
export type TransportErrorCode =
  | 'BLOCKED_ADDRESS'
  | 'BLOCKED_PORT'
  | 'CONNECT_TIMEOUT'
  | 'CONNECT_REFUSED'
  | 'CLOSED'
  | 'PROTOCOL';

export const TRANSPORT_ERROR_CODES: readonly TransportErrorCode[] = [
  'BLOCKED_ADDRESS',
  'BLOCKED_PORT',
  'CONNECT_TIMEOUT',
  'CONNECT_REFUSED',
  'CLOSED',
  'PROTOCOL',
];

export class TransportError extends Error {
  readonly code: TransportErrorCode;

  constructor(code: TransportErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TransportError';
    this.code = code;
  }
}

export function isTransportError(
  value: unknown,
  code?: TransportErrorCode,
): value is TransportError {
  return value instanceof TransportError && (code === undefined || value.code === code);
}
