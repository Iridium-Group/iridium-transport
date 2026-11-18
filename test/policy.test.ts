import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isTransportError } from '../src/errors.ts';
import { AddressPolicy, DEFAULT_BLOCKED_PORTS, type LookupFunction } from '../src/policy.ts';

function fakeLookup(table: Record<string, string[]>): LookupFunction {
  return async (host) => {
    const answers = table[host];
    if (!answers) {
      const err = new Error(`getaddrinfo ENOTFOUND ${host}`) as NodeJS.ErrnoException;
      err.code = 'ENOTFOUND';
      throw err;
    }
    return answers.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  };
}

describe('AddressPolicy ports', () => {
  it('blocks 25, 465 and 587 by default', () => {
    assert.deepEqual([...DEFAULT_BLOCKED_PORTS], [25, 465, 587]);
    const policy = new AddressPolicy();
    for (const port of [25, 465, 587]) {
      assert.throws(
        () => policy.checkPort(port),
        (e) => isTransportError(e, 'BLOCKED_PORT'),
      );
    }
    policy.checkPort(80);
    policy.checkPort(443);
  });

  it('rejects invalid ports', () => {
    const policy = new AddressPolicy();
    for (const port of [0, -1, 65536, 1.5, Number.NaN]) {
      assert.throws(
        () => policy.checkPort(port),
        (e) => isTransportError(e, 'BLOCKED_PORT'),
      );
    }
  });

  it('replaces the default list when blockedPorts is given', () => {
    const policy = new AddressPolicy({ blockedPorts: [8080] });
    policy.checkPort(25);
    assert.throws(
      () => policy.checkPort(8080),
      (e) => isTransportError(e, 'BLOCKED_PORT'),
    );
  });

  it('honors custom blocked ports and an allow list', () => {
    const policy = new AddressPolicy({ blockedPorts: [8080], allowedPorts: [80, 443, 8080] });
    policy.checkPort(80);
    assert.throws(
      () => policy.checkPort(8080),
      (e) => isTransportError(e, 'BLOCKED_PORT'),
    );
    assert.throws(
      () => policy.checkPort(22),
      (e) => isTransportError(e, 'BLOCKED_PORT'),
    );
  });
});

describe('AddressPolicy resolution', () => {
  const lookup = fakeLookup({
    'public.test': ['93.184.215.14', '2606:2800:21f:cb07:6820:80da:af6b:8b2c'],
    'loopback.test': ['127.0.0.1'],
    'metadata.test': ['169.254.169.254'],
    'mixed.test': ['93.184.215.14', '10.0.0.5'],
    'ula.test': ['fd12:3456::1'],
    'mapped.test': ['::ffff:127.0.0.1'],
    'empty.test': [],
    'garbage.test': ['not-an-ip'],
  });
  const policy = new AddressPolicy({ lookup });

  it('returns the first answer for a public host', async () => {
    assert.deepEqual(await policy.resolve('public.test'), {
      address: '93.184.215.14',
      family: 4,
    });
  });

  for (const host of ['loopback.test', 'metadata.test', 'ula.test', 'mapped.test']) {
    it(`blocks ${host}`, async () => {
      await assert.rejects(policy.resolve(host), (e) => isTransportError(e, 'BLOCKED_ADDRESS'));
    });
  }

  it('blocks a host when any answer is private', async () => {
    await assert.rejects(policy.resolve('mixed.test'), (e) =>
      isTransportError(e, 'BLOCKED_ADDRESS'),
    );
  });

  it('blocks resolver answers that are not IP addresses', async () => {
    await assert.rejects(policy.resolve('garbage.test'), (e) =>
      isTransportError(e, 'BLOCKED_ADDRESS'),
    );
  });

  it('checks IP literals without DNS', async () => {
    await assert.rejects(policy.resolve('127.0.0.1'), (e) =>
      isTransportError(e, 'BLOCKED_ADDRESS'),
    );
    await assert.rejects(policy.resolve('[::1]'), (e) => isTransportError(e, 'BLOCKED_ADDRESS'));
    assert.deepEqual(await policy.resolve('1.1.1.1'), { address: '1.1.1.1', family: 4 });
    assert.deepEqual(await policy.resolve('[2606:4700::1111]'), {
      address: '2606:4700::1111',
      family: 6,
    });
  });

  it('reports unresolvable hosts as CONNECT_REFUSED', async () => {
    await assert.rejects(policy.resolve('nope.test'), (e) =>
      isTransportError(e, 'CONNECT_REFUSED'),
    );
    await assert.rejects(policy.resolve('empty.test'), (e) =>
      isTransportError(e, 'CONNECT_REFUSED'),
    );
    await assert.rejects(policy.resolve('  '), (e) => isTransportError(e, 'CONNECT_REFUSED'));
  });

  it('allows private answers when blockPrivateAddresses is false', async () => {
    const open = new AddressPolicy({ lookup, blockPrivateAddresses: false });
    assert.deepEqual(await open.resolve('loopback.test'), { address: '127.0.0.1', family: 4 });
  });

  it('checks the port before resolving', async () => {
    let called = false;
    const p = new AddressPolicy({
      lookup: async () => {
        called = true;
        return [{ address: '1.1.1.1', family: 4 }];
      },
    });
    await assert.rejects(p.check({ host: 'x.test', port: 25 }), (e) =>
      isTransportError(e, 'BLOCKED_PORT'),
    );
    assert.equal(called, false);
  });
});
