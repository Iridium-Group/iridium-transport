import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as api from '../src/index.ts';

describe('createTransport', () => {
  it('builds a direct transport with the security settings', () => {
    const t = api.createTransport(
      { type: 'direct' },
      {
        security: { blockPrivateAddresses: true, blockedPorts: [25, 2525] },
        connectTimeoutMs: 500,
      },
    );
    assert.ok(t instanceof api.DirectTransport);
    assert.equal(t.name, 'direct');
    assert.equal(t.connectTimeoutMs, 500);
    assert.equal(t.policy.blockedPorts.has(2525), true);
    assert.equal(t.policy.blockPrivateAddresses, true);
  });

  it('defaults the direct policy when no security is given', () => {
    const t = api.createTransport({ type: 'direct' }) as api.DirectTransport;
    assert.deepEqual([...t.policy.blockedPorts], [25, 465, 587]);
  });

  it('builds a Wisp transport from a url', () => {
    const t = api.createTransport({
      type: 'wisp',
      wispPath: '/wisp/',
      url: 'ws://127.0.0.1:1/wisp/',
    });
    assert.ok(t instanceof api.WispClientTransport);
    assert.equal(t.name, 'wisp');
  });

  it('rejects incomplete or unknown config', () => {
    assert.throws(() => api.createTransport({ type: 'wisp' }), TypeError);
    assert.throws(() => api.createTransport({ type: 'carrier-pigeon' } as never), TypeError);
  });
});

describe('public API', () => {
  it('exports the contract surface', () => {
    for (const name of [
      'DirectTransport',
      'WispClientTransport',
      'MemoryTransport',
      'AddressPolicy',
      'TransportError',
      'createTransport',
      'isPrivateAddress',
      'encodeConnect',
      'decodePacket',
    ]) {
      assert.equal(typeof (api as Record<string, unknown>)[name], 'function', name);
    }
    assert.deepEqual(
      [...api.TRANSPORT_ERROR_CODES],
      [
        'BLOCKED_ADDRESS',
        'BLOCKED_PORT',
        'CONNECT_TIMEOUT',
        'CONNECT_REFUSED',
        'CLOSED',
        'PROTOCOL',
      ],
    );
    const err = new api.TransportError('CLOSED', 'x');
    assert.equal(err.code, 'CLOSED');
    assert.equal(err.name, 'TransportError');
    assert.ok(err instanceof Error);
  });
});
