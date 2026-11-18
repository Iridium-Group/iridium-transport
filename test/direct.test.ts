import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { DirectTransport } from '../src/direct.ts';
import { isTransportError } from '../src/errors.ts';
import { AddressPolicy } from '../src/policy.ts';
import {
  readAll,
  readExactly,
  startEchoServer,
  startTcpServer,
  unusedPort,
  type TcpTestServer,
} from './fixtures/tcp.ts';

const text = new TextEncoder();

/** A policy that allows loopback so tests can reach local servers. */
function localPolicy(table: Record<string, string> = {}): AddressPolicy {
  return new AddressPolicy({
    blockPrivateAddresses: false,
    lookup: async (host) => {
      const address = table[host];
      if (!address) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
      return [{ address, family: 4 }];
    },
  });
}

describe('DirectTransport', () => {
  let echo: TcpTestServer;
  before(async () => {
    echo = await startEchoServer();
  });
  after(async () => {
    await echo.close();
  });

  it('blocks loopback with the default policy', async () => {
    const transport = new DirectTransport();
    await assert.rejects(transport.connect({ host: '127.0.0.1', port: echo.port }), (e) =>
      isTransportError(e, 'BLOCKED_ADDRESS'),
    );
    await assert.rejects(transport.connect({ host: '[::1]', port: echo.port }), (e) =>
      isTransportError(e, 'BLOCKED_ADDRESS'),
    );
    await assert.rejects(transport.connect({ host: 'localhost', port: echo.port }), (e) =>
      isTransportError(e, 'BLOCKED_ADDRESS'),
    );
    await transport.close();
  });

  it('blocks the metadata address and blocked ports before connecting', async () => {
    const transport = new DirectTransport();
    await assert.rejects(transport.connect({ host: '169.254.169.254', port: 80 }), (e) =>
      isTransportError(e, 'BLOCKED_ADDRESS'),
    );
    for (const port of [25, 465, 587]) {
      await assert.rejects(transport.connect({ host: '93.184.215.14', port }), (e) =>
        isTransportError(e, 'BLOCKED_PORT'),
      );
    }
    await transport.close();
  });

  it('connects to the address the policy resolved, not the hostname', async () => {
    const transport = new DirectTransport({ policy: localPolicy({ 'echo.test': '127.0.0.1' }) });
    try {
      const conn = await transport.connect({ host: 'echo.test', port: echo.port });
      assert.equal(conn.info.remoteHost, 'echo.test');
      assert.equal(conn.info.remoteAddress, '127.0.0.1');
      assert.ok(conn.info.openedAt <= Date.now());
      const writer = conn.writable.getWriter();
      await writer.write(text.encode('ping'));
      const reader = conn.readable.getReader();
      assert.equal(new TextDecoder().decode(await readExactly(reader, 4)), 'ping');
      reader.releaseLock();
      writer.releaseLock();
      await conn.close();
      await conn.close();
    } finally {
      await transport.close();
    }
  });

  it('ends the readable when the server closes', async () => {
    const server = await startTcpServer((socket) => socket.end('bye'));
    const transport = new DirectTransport({ policy: localPolicy() });
    try {
      const conn = await transport.connect({ host: '127.0.0.1', port: server.port });
      assert.equal(new TextDecoder().decode(await readAll(conn.readable)), 'bye');
    } finally {
      await transport.close();
      await server.close();
    }
  });

  it('reports CONNECT_REFUSED when nothing is listening', async () => {
    const transport = new DirectTransport({ policy: localPolicy() });
    const port = await unusedPort();
    await assert.rejects(transport.connect({ host: '127.0.0.1', port }), (e) =>
      isTransportError(e, 'CONNECT_REFUSED'),
    );
    await transport.close();
  });

  it('reports CONNECT_REFUSED when the host does not resolve', async () => {
    const transport = new DirectTransport({ policy: localPolicy() });
    await assert.rejects(transport.connect({ host: 'missing.test', port: 80 }), (e) =>
      isTransportError(e, 'CONNECT_REFUSED'),
    );
    await transport.close();
  });

  it('times out when the TLS handshake never completes', async () => {
    // Accepts TCP but never speaks TLS, so secureConnect never fires.
    const silent = await startTcpServer(() => undefined);
    const transport = new DirectTransport({ policy: localPolicy(), connectTimeoutMs: 150 });
    try {
      const started = Date.now();
      await assert.rejects(
        transport.connect({ host: '127.0.0.1', port: silent.port, tls: true }),
        (e) => isTransportError(e, 'CONNECT_TIMEOUT'),
      );
      const elapsed = Date.now() - started;
      assert.ok(elapsed >= 100 && elapsed < 2000, `elapsed ${elapsed} ms`);
    } finally {
      await transport.close();
      await silent.close();
    }
  });

  it('honors a per-call timeout and abort signal', async () => {
    const silent = await startTcpServer(() => undefined);
    const transport = new DirectTransport({ policy: localPolicy(), connectTimeoutMs: 60_000 });
    try {
      await assert.rejects(
        transport.connect({ host: '127.0.0.1', port: silent.port, tls: true }, { timeoutMs: 50 }),
        (e) => isTransportError(e, 'CONNECT_TIMEOUT'),
      );
      const controller = new AbortController();
      const attempt = transport.connect(
        { host: '127.0.0.1', port: silent.port, tls: true },
        { signal: controller.signal },
      );
      setTimeout(() => controller.abort(), 30);
      await assert.rejects(attempt, (e) => isTransportError(e, 'CLOSED'));
    } finally {
      await transport.close();
      await silent.close();
    }
  });

  it('closes open connections and refuses new ones after close()', async () => {
    const transport = new DirectTransport({ policy: localPolicy() });
    const conn = await transport.connect({ host: '127.0.0.1', port: echo.port });
    await transport.close();
    const result = await conn.readable.getReader().read();
    assert.equal(result.done, true);
    await assert.rejects(transport.connect({ host: '127.0.0.1', port: echo.port }), (e) =>
      isTransportError(e, 'CLOSED'),
    );
  });
});
