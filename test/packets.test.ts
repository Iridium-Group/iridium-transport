import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isTransportError } from '../src/errors.ts';
import {
  CloseReason,
  PacketType,
  StreamType,
  closeReasonName,
  closeReasonToErrorCode,
  decodePacket,
  encodeClose,
  encodeConnect,
  encodeContinue,
  encodeData,
  encodePacket,
} from '../src/wisp/packets.ts';

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

describe('Wisp packet encoding', () => {
  it('encodes CONNECT with little-endian stream id and port', () => {
    const bytes = encodeConnect(0x01020304, 'example.com', 443);
    assert.equal(
      hex(bytes),
      '01' + '04030201' + '01' + 'bb01' + Buffer.from('example.com').toString('hex'),
    );
  });

  it('encodes UDP CONNECT stream type', () => {
    const bytes = encodeConnect(1, 'h', 53, StreamType.UDP);
    assert.equal(bytes[5], 0x02);
  });

  it('encodes DATA', () => {
    assert.equal(hex(encodeData(7, new Uint8Array([0xde, 0xad]))), '02' + '07000000' + 'dead');
  });

  it('encodes CONTINUE with a little-endian uint32', () => {
    assert.equal(hex(encodeContinue(0, 128)), '03' + '00000000' + '80000000');
    assert.equal(hex(encodeContinue(9, 0xffffffff)), '03' + '09000000' + 'ffffffff');
  });

  it('encodes CLOSE', () => {
    assert.equal(hex(encodeClose(0xffffffff, CloseReason.VOLUNTARY)), '04' + 'ffffffff' + '02');
  });

  it('rejects out-of-range fields', () => {
    assert.throws(() => encodeData(-1, new Uint8Array()), RangeError);
    assert.throws(() => encodeData(2 ** 32, new Uint8Array()), RangeError);
    assert.throws(() => encodeConnect(1, 'h', 70000), RangeError);
    assert.throws(() => encodeContinue(1, -1), RangeError);
    assert.throws(() => encodeClose(1, 256), RangeError);
  });
});

describe('Wisp packet decoding', () => {
  it('round-trips every packet type', () => {
    const packets = [
      {
        type: PacketType.CONNECT,
        streamId: 42,
        streamType: StreamType.TCP,
        port: 8080,
        hostname: 'bücher.example',
      },
      { type: PacketType.DATA, streamId: 42, payload: new Uint8Array([1, 2, 3]) },
      { type: PacketType.CONTINUE, streamId: 42, bufferRemaining: 64 },
      { type: PacketType.CLOSE, streamId: 42, reason: CloseReason.BLOCKED },
    ] as const;
    for (const packet of packets) {
      const decoded = decodePacket(encodePacket(packet));
      assert.deepEqual(decoded, packet);
    }
  });

  it('decodes from an ArrayBuffer and from a subarray with an offset', () => {
    const encoded = encodeData(3, new Uint8Array([9, 8, 7]));
    const padded = new Uint8Array(encoded.byteLength + 4);
    padded.set(encoded, 4);
    const fromView = decodePacket(padded.subarray(4));
    const fromBuffer = decodePacket(encoded.slice().buffer);
    for (const p of [fromView, fromBuffer]) {
      assert.equal(p.type, PacketType.DATA);
      assert.equal(p.streamId, 3);
      assert.deepEqual([...(p as { payload: Uint8Array }).payload], [9, 8, 7]);
    }
  });

  it('decodes an empty DATA payload', () => {
    const p = decodePacket(encodeData(1, new Uint8Array()));
    assert.equal((p as { payload: Uint8Array }).payload.byteLength, 0);
  });

  it('keeps unknown packet types instead of throwing', () => {
    const p = decodePacket(new Uint8Array([0x05, 1, 0, 0, 0, 0xaa]));
    assert.equal(p.type, 0x05);
    assert.equal('unknown' in p, true);
  });

  it('throws PROTOCOL errors for malformed packets', () => {
    const bad = [
      new Uint8Array([]),
      new Uint8Array([0x02, 0, 0, 0]),
      new Uint8Array([0x01, 1, 0, 0, 0, 1, 80]),
      new Uint8Array([0x03, 1, 0, 0, 0, 1, 2, 3]),
      new Uint8Array([0x03, 1, 0, 0, 0, 1, 2, 3, 4, 5]),
      new Uint8Array([0x04, 1, 0, 0, 0]),
      new Uint8Array([0x04, 1, 0, 0, 0, 2, 2]),
      new Uint8Array([0x01, 1, 0, 0, 0, 1, 80, 0, 0xff, 0xfe]),
    ];
    for (const bytes of bad) {
      assert.throws(
        () => decodePacket(bytes),
        (e) => isTransportError(e, 'PROTOCOL'),
        hex(bytes),
      );
    }
  });
});

describe('Wisp close reasons', () => {
  it('maps reasons to transport error codes', () => {
    assert.equal(closeReasonToErrorCode(CloseReason.BLOCKED), 'BLOCKED_ADDRESS');
    assert.equal(closeReasonToErrorCode(CloseReason.INVALID_INFO), 'BLOCKED_ADDRESS');
    assert.equal(closeReasonToErrorCode(CloseReason.CONNECT_TIMEOUT), 'CONNECT_TIMEOUT');
    assert.equal(closeReasonToErrorCode(CloseReason.CONNECTION_REFUSED), 'CONNECT_REFUSED');
    assert.equal(closeReasonToErrorCode(CloseReason.UNREACHABLE), 'CONNECT_REFUSED');
    assert.equal(closeReasonToErrorCode(CloseReason.NETWORK_ERROR), 'CLOSED');
    assert.equal(closeReasonToErrorCode(CloseReason.THROTTLED), 'CLOSED');
    assert.equal(closeReasonToErrorCode(0x99), 'CLOSED');
  });

  it('names reasons', () => {
    assert.equal(closeReasonName(0x48), 'BLOCKED');
    assert.equal(closeReasonName(0x02), 'VOLUNTARY');
    assert.equal(closeReasonName(0x99), '0x99');
  });

  it('uses the protocol values', () => {
    assert.deepEqual(
      Object.values(CloseReason),
      [0x01, 0x02, 0x03, 0x41, 0x42, 0x43, 0x44, 0x47, 0x48, 0x49, 0x81],
    );
  });
});
