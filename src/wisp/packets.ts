import { TransportError } from '../errors.ts';

/**
 * Wisp v1 packet framing.
 *
 * Every packet is: type (uint8) | stream id (uint32, little-endian) | payload.
 * All integers are little-endian. Written from the public protocol description at
 * https://github.com/MercuryWorkshop/wisp-protocol.
 */

export const PacketType = {
  CONNECT: 0x01,
  DATA: 0x02,
  CONTINUE: 0x03,
  CLOSE: 0x04,
} as const;
export type PacketType = (typeof PacketType)[keyof typeof PacketType];

export const StreamType = {
  TCP: 0x01,
  UDP: 0x02,
} as const;
export type StreamType = (typeof StreamType)[keyof typeof StreamType];

/** Close reasons defined by the protocol. */
export const CloseReason = {
  /** Reason unspecified or unknown. */
  UNKNOWN: 0x01,
  /** Voluntary stream closure. */
  VOLUNTARY: 0x02,
  /** Unexpected closure due to a network error. */
  NETWORK_ERROR: 0x03,
  /** Server: stream creation failed due to invalid information (for example a reserved address or bad port). */
  INVALID_INFO: 0x41,
  /** Server: destination host unreachable or does not resolve. */
  UNREACHABLE: 0x42,
  /** Server: stream creation timed out. */
  CONNECT_TIMEOUT: 0x43,
  /** Server: destination refused the connection. */
  CONNECTION_REFUSED: 0x44,
  /** Server: TCP data transfer timed out. */
  DATA_TIMEOUT: 0x47,
  /** Server: destination intentionally blocked by the server. */
  BLOCKED: 0x48,
  /** Server: connection throttled. */
  THROTTLED: 0x49,
  /** Client: unexpected client error, cannot receive more data. */
  CLIENT_ERROR: 0x81,
} as const;
export type CloseReason = (typeof CloseReason)[keyof typeof CloseReason];

/** Bytes in the packet header (type + stream id). */
export const HEADER_LENGTH = 5;
/** The largest stream id the uint32 field can carry. */
export const MAX_STREAM_ID = 0xffffffff;

export type WispPacket =
  | {
      type: typeof PacketType.CONNECT;
      streamId: number;
      streamType: number;
      port: number;
      hostname: string;
    }
  | { type: typeof PacketType.DATA; streamId: number; payload: Uint8Array }
  | { type: typeof PacketType.CONTINUE; streamId: number; bufferRemaining: number }
  | { type: typeof PacketType.CLOSE; streamId: number; reason: number }
  /** A packet type this implementation does not know. Kept so callers can ignore it. */
  | { type: number; streamId: number; unknown: true; payload: Uint8Array };

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

function assertStreamId(streamId: number): void {
  if (!Number.isInteger(streamId) || streamId < 0 || streamId > MAX_STREAM_ID) {
    throw new RangeError(`Invalid stream id: ${String(streamId)}`);
  }
}

function header(type: number, streamId: number, payloadLength: number): Uint8Array {
  assertStreamId(streamId);
  const bytes = new Uint8Array(HEADER_LENGTH + payloadLength);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, type);
  view.setUint32(1, streamId, true);
  return bytes;
}

export function encodeConnect(
  streamId: number,
  hostname: string,
  port: number,
  streamType: number = StreamType.TCP,
): Uint8Array {
  if (!Number.isInteger(port) || port < 0 || port > 0xffff) {
    throw new RangeError(`Invalid port: ${String(port)}`);
  }
  const host = encoder.encode(hostname);
  const bytes = header(PacketType.CONNECT, streamId, 3 + host.byteLength);
  const view = new DataView(bytes.buffer);
  view.setUint8(5, streamType);
  view.setUint16(6, port, true);
  bytes.set(host, 8);
  return bytes;
}

export function encodeData(streamId: number, payload: Uint8Array): Uint8Array {
  const bytes = header(PacketType.DATA, streamId, payload.byteLength);
  bytes.set(payload, HEADER_LENGTH);
  return bytes;
}

export function encodeContinue(streamId: number, bufferRemaining: number): Uint8Array {
  if (!Number.isInteger(bufferRemaining) || bufferRemaining < 0 || bufferRemaining > 0xffffffff) {
    throw new RangeError(`Invalid buffer size: ${String(bufferRemaining)}`);
  }
  const bytes = header(PacketType.CONTINUE, streamId, 4);
  new DataView(bytes.buffer).setUint32(5, bufferRemaining, true);
  return bytes;
}

export function encodeClose(streamId: number, reason: number): Uint8Array {
  if (!Number.isInteger(reason) || reason < 0 || reason > 0xff) {
    throw new RangeError(`Invalid close reason: ${String(reason)}`);
  }
  const bytes = header(PacketType.CLOSE, streamId, 1);
  bytes[5] = reason;
  return bytes;
}

/** Encode any known packet. */
export function encodePacket(packet: WispPacket): Uint8Array {
  if ('unknown' in packet) {
    const bytes = header(packet.type, packet.streamId, packet.payload.byteLength);
    bytes.set(packet.payload, HEADER_LENGTH);
    return bytes;
  }
  switch (packet.type) {
    case PacketType.CONNECT:
      return encodeConnect(packet.streamId, packet.hostname, packet.port, packet.streamType);
    case PacketType.DATA:
      return encodeData(packet.streamId, packet.payload);
    case PacketType.CONTINUE:
      return encodeContinue(packet.streamId, packet.bufferRemaining);
    case PacketType.CLOSE:
      return encodeClose(packet.streamId, packet.reason);
  }
}

function protocolError(message: string): TransportError {
  return new TransportError('PROTOCOL', `Malformed Wisp packet: ${message}`);
}

/**
 * Decode one packet. Throws `TransportError('PROTOCOL')` when the packet is truncated or a
 * known packet type has the wrong payload length. Unknown packet types decode with `unknown: true`.
 * The DATA payload is a view into `input`; copy it if `input` will be reused.
 */
export function decodePacket(input: Uint8Array | ArrayBuffer): WispPacket {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength < HEADER_LENGTH) {
    throw protocolError(`expected at least ${HEADER_LENGTH} bytes, got ${bytes.byteLength}`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type = view.getUint8(0);
  const streamId = view.getUint32(1, true);
  const payloadLength = bytes.byteLength - HEADER_LENGTH;

  switch (type) {
    case PacketType.CONNECT: {
      if (payloadLength < 3) throw protocolError('CONNECT payload shorter than 3 bytes');
      let hostname: string;
      try {
        hostname = decoder.decode(bytes.subarray(8));
      } catch {
        throw protocolError('CONNECT hostname is not valid UTF-8');
      }
      return {
        type,
        streamId,
        streamType: view.getUint8(5),
        port: view.getUint16(6, true),
        hostname,
      };
    }
    case PacketType.DATA:
      return { type, streamId, payload: bytes.subarray(HEADER_LENGTH) };
    case PacketType.CONTINUE:
      if (payloadLength !== 4) throw protocolError('CONTINUE payload must be 4 bytes');
      return { type, streamId, bufferRemaining: view.getUint32(5, true) };
    case PacketType.CLOSE:
      if (payloadLength !== 1) throw protocolError('CLOSE payload must be 1 byte');
      return { type, streamId, reason: view.getUint8(5) };
    default:
      return { type, streamId, unknown: true, payload: bytes.subarray(HEADER_LENGTH) };
  }
}

/** Map a Wisp close reason to the matching TransportError code. */
export function closeReasonToErrorCode(
  reason: number,
): 'BLOCKED_ADDRESS' | 'CONNECT_TIMEOUT' | 'CONNECT_REFUSED' | 'CLOSED' {
  switch (reason) {
    case CloseReason.INVALID_INFO:
    case CloseReason.BLOCKED:
      return 'BLOCKED_ADDRESS';
    case CloseReason.CONNECT_TIMEOUT:
      return 'CONNECT_TIMEOUT';
    case CloseReason.UNREACHABLE:
    case CloseReason.CONNECTION_REFUSED:
      return 'CONNECT_REFUSED';
    default:
      return 'CLOSED';
  }
}

/** A short human-readable name for a close reason. */
export function closeReasonName(reason: number): string {
  for (const [name, value] of Object.entries(CloseReason)) {
    if (value === reason) return name;
  }
  return `0x${reason.toString(16).padStart(2, '0')}`;
}
