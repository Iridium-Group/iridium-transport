import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ipVersion,
  isPrivateAddress,
  isPrivateIPv4,
  isPrivateIPv6,
  parseIPv4,
  parseIPv6,
} from '../src/address.ts';

describe('parseIPv4', () => {
  it('parses dotted quads', () => {
    assert.deepEqual(parseIPv4('192.168.1.20'), [192, 168, 1, 20]);
  });
  it('rejects malformed input', () => {
    for (const bad of ['1.2.3', '1.2.3.4.5', '256.1.1.1', '01.2.3.4', 'a.b.c.d', '', '1..2.3']) {
      assert.equal(parseIPv4(bad), null, bad);
    }
  });
});

describe('parseIPv6', () => {
  it('expands compressed forms', () => {
    assert.deepEqual(parseIPv6('::1'), [0, 0, 0, 0, 0, 0, 0, 1]);
    assert.deepEqual(parseIPv6('fe80::1%eth0'), [0xfe80, 0, 0, 0, 0, 0, 0, 1]);
    assert.deepEqual(parseIPv6('[2001:db8::]'), [0x2001, 0xdb8, 0, 0, 0, 0, 0, 0]);
    assert.deepEqual(parseIPv6('::'), [0, 0, 0, 0, 0, 0, 0, 0]);
  });
  it('handles IPv4 tails', () => {
    assert.deepEqual(parseIPv6('::ffff:127.0.0.1'), [0, 0, 0, 0, 0, 0xffff, 0x7f00, 0x0001]);
    assert.deepEqual(parseIPv6('64:ff9b::10.0.0.1'), [0x64, 0xff9b, 0, 0, 0, 0, 0x0a00, 0x0001]);
    assert.deepEqual(parseIPv6('1:2:3:4:5:6:1.2.3.4'), [1, 2, 3, 4, 5, 6, 0x0102, 0x0304]);
  });
  it('rejects malformed input', () => {
    for (const bad of ['1:2:3', ':::', '1::2::3', 'g::1', '12345::', '1:2:3:4:5:6:7:8:9', 'x']) {
      assert.equal(parseIPv6(bad), null, bad);
    }
  });
});

describe('isPrivateIPv4', () => {
  const privateCases: Array<[string, string]> = [
    ['0.0.0.0', 'this network'],
    ['0.255.255.255', 'this network'],
    ['10.0.0.1', 'RFC 1918 10/8'],
    ['10.255.255.255', 'RFC 1918 10/8'],
    ['100.64.0.1', 'CGNAT'],
    ['100.127.255.254', 'CGNAT'],
    ['127.0.0.1', 'loopback'],
    ['127.255.255.254', 'loopback'],
    ['169.254.0.1', 'link-local'],
    ['169.254.169.254', 'cloud metadata'],
    ['172.16.0.1', 'RFC 1918 172.16/12'],
    ['172.31.255.255', 'RFC 1918 172.16/12'],
    ['192.0.0.8', 'IETF assignments'],
    ['192.0.2.10', 'TEST-NET-1'],
    ['192.88.99.1', '6to4 relay'],
    ['192.168.0.1', 'RFC 1918 192.168/16'],
    ['198.18.0.1', 'benchmarking'],
    ['198.19.255.255', 'benchmarking'],
    ['198.51.100.7', 'TEST-NET-2'],
    ['203.0.113.9', 'TEST-NET-3'],
    ['224.0.0.1', 'multicast'],
    ['239.255.255.250', 'multicast'],
    ['240.0.0.1', 'reserved'],
    ['255.255.255.255', 'broadcast'],
  ];
  for (const [ip, label] of privateCases) {
    it(`blocks ${ip} (${label})`, () => assert.equal(isPrivateIPv4(ip), true));
  }

  const publicCases = [
    '1.1.1.1',
    '8.8.8.8',
    '93.184.215.14',
    '100.63.255.255',
    '100.128.0.0',
    '172.15.255.255',
    '172.32.0.0',
    '169.253.255.255',
    '192.169.0.1',
    '198.17.255.255',
    '198.20.0.0',
    '223.255.255.255',
  ];
  for (const ip of publicCases) {
    it(`allows ${ip}`, () => assert.equal(isPrivateIPv4(ip), false));
  }

  it('returns false for non-IPv4 input', () => {
    assert.equal(isPrivateIPv4('::1'), false);
    assert.equal(isPrivateIPv4('example.com'), false);
  });
});

describe('isPrivateIPv6', () => {
  const privateCases: Array<[string, string]> = [
    ['::', 'unspecified'],
    ['::1', 'loopback'],
    ['::ffff:8.8.8.8', 'IPv4-mapped (always blocked)'],
    ['::ffff:127.0.0.1', 'IPv4-mapped loopback'],
    ['::ffff:7f00:1', 'IPv4-mapped hex form'],
    ['::127.0.0.1', 'IPv4-compatible'],
    ['::ffff:0:10.0.0.1', 'IPv4-translated'],
    ['64:ff9b::127.0.0.1', 'NAT64 to loopback'],
    ['64:ff9b::a9fe:a9fe', 'NAT64 to metadata'],
    ['64:ff9b:1::1', 'local-use NAT64'],
    ['100::1', 'discard'],
    ['2001::1', 'Teredo'],
    ['2001:db8::1', 'documentation'],
    ['2002:7f00:1::', '6to4 to loopback'],
    ['2002:c0a8:101::1', '6to4 to 192.168.1.1'],
    ['3fff::1', 'documentation (RFC 9637)'],
    ['fc00::1', 'unique local'],
    ['fd00:ec2::254', 'unique local metadata'],
    ['fdff:ffff::1', 'unique local'],
    ['fe80::1', 'link-local'],
    ['febf::1', 'link-local'],
    ['fec0::1', 'site-local'],
    ['ff02::1', 'multicast'],
    ['[::1]', 'bracketed loopback'],
    ['fe80::1%lo0', 'link-local with zone'],
  ];
  for (const [ip, label] of privateCases) {
    it(`blocks ${ip} (${label})`, () => assert.equal(isPrivateIPv6(ip), true));
  }

  const publicCases = [
    '2606:4700:4700::1111',
    '2001:4860:4860::8888',
    '64:ff9b::808:808',
    '2002:808:808::1',
    '2a00:1450:4001::1',
  ];
  for (const ip of publicCases) {
    it(`allows ${ip}`, () => assert.equal(isPrivateIPv6(ip), false));
  }

  it('returns false for non-IPv6 input', () => {
    assert.equal(isPrivateIPv6('127.0.0.1'), false);
  });
});

describe('isPrivateAddress', () => {
  it('dispatches by family', () => {
    assert.equal(isPrivateAddress('10.1.2.3'), true);
    assert.equal(isPrivateAddress('fe80::1'), true);
    assert.equal(isPrivateAddress('1.1.1.1'), false);
    assert.equal(isPrivateAddress('2606:4700::1'), false);
  });
  it('fails closed on invalid input', () => {
    assert.equal(isPrivateAddress('example.com'), true);
    assert.equal(isPrivateAddress(''), true);
    assert.equal(isPrivateAddress('999.1.1.1'), true);
  });
  it('reports the IP version', () => {
    assert.equal(ipVersion('1.2.3.4'), 4);
    assert.equal(ipVersion('[::1]'), 6);
    assert.equal(ipVersion('localhost'), 0);
  });
});
