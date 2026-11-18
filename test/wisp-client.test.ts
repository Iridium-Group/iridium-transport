import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { isTransportError } from '../src/errors.ts';
import { CloseReason, PacketType } from '../src/wisp/packets.ts';
import { WispClientTransport } from '../src/wisp/client.ts';
import { startEchoServer, readExactly, unusedPort, type TcpTestServer } from './fixtures/tcp.ts';
import { startWispServer, type WispTestServer } from './fixtures/wisp-server.ts';

const text = new TextEncoder();
const fromText = new TextDecoder();

describe('WispClientTransport', () => {
  let echo: TcpTestServer;
  before(async () => {
    echo = await startEchoServer();
  });
  after(async () => {
    await echo.close();
  });

  it('echoes data through a Wisp server', async () => {
    const server = await startWispServer();
    const transport = new WispClientTransport({ url: server.url });
    try {
      const conn = await transport.connect({ host: '127.0.0.1', port: echo.port });
      assert.equal(conn.info.remoteHost, '127.0.0.1');
      assert.equal(conn.info.remotePort, echo.port);
      const writer = conn.writable.getWriter();
      await writer.write(text.encode('hello wisp'));
      const reader = conn.readable.getReader();
      assert.equal(fromText.decode(await readExactly(reader, 10)), 'hello wisp');

      const connect = server.received.find((p) => p.type === PacketType.CONNECT);
      assert.ok(connect && 'hostname' in connect);
      assert.equal(connect.hostname, '127.0.0.1');
      assert.equal(connect.port, echo.port);
      assert.equal(connect.streamId, conn.streamId);
      assert.notEqual(conn.streamId, 0);

      reader.releaseLock();
      writer.releaseLock();
      await conn.close();
      assert.equal(await conn.closed, CloseReason.VOLUNTARY);
      await delay(20);
      const close = server.received.find((p) => p.type === PacketType.CLOSE);
      assert.ok(close && 'reason' in close);
      assert.equal(close.reason, CloseReason.VOLUNTARY);
    } finally {
      await transport.close();
      await server.close();
    }
  });

  it('multiplexes several streams over one WebSocket', async () => {
    const server = await startWispServer();
    const transport = new WispClientTransport({ url: server.url });
    try {
      const conns = await Promise.all(
        [0, 1, 2].map(() => transport.connect({ host: '127.0.0.1', port: echo.port })),
      );
      assert.equal(new Set(conns.map((c) => c.streamId)).size, 3);
      const results = await Promise.all(
        conns.map(async (conn, i) => {
          const w = conn.writable.getWriter();
          await w.write(text.encode(`stream-${i}`));
          return fromText.decode(await readExactly(conn.readable.getReader(), 8));
        }),
      );
      assert.deepEqual(results, ['stream-0', 'stream-1', 'stream-2']);
    } finally {
      await transport.close();
      await server.close();
    }
  });

  it('never sends more DATA packets than the server granted', async () => {
    const server = await startWispServer({ bufferSize: 3 });
    const transport = new WispClientTransport({ url: server.url });
    try {
      const conn = await transport.connect({ host: '127.0.0.1', port: echo.port });
      const writer = conn.writable.getWriter();
      const reader = conn.readable.getReader();
      const chunks = 20;
      for (let i = 0; i < chunks; i++) await writer.write(new Uint8Array([i]));
      const echoed = await readExactly(reader, chunks);
      assert.deepEqual([...echoed], [...Array(chunks).keys()]);
      assert.ok(server.maxUnacknowledged <= 3, `saw ${server.maxUnacknowledged} unacknowledged`);
      assert.equal(server.received.filter((p) => p.type === PacketType.DATA).length, chunks);
    } finally {
      await transport.close();
      await server.close();
    }
  });

  it('waits for CONTINUE when the buffer is used up', async () => {
    const server = await startWispServer({ bufferSize: 2, manualContinue: true });
    const transport = new WispClientTransport({ url: server.url });
    try {
      const conn = await transport.connect({ host: '127.0.0.1', port: echo.port });
      const writer = conn.writable.getWriter();
      await writer.write(new Uint8Array([1]));
      await writer.write(new Uint8Array([2]));
      let thirdDone = false;
      const third = writer.write(new Uint8Array([3])).then(() => {
        thirdDone = true;
      });
      await delay(50);
      assert.equal(thirdDone, false, 'write should wait for credit');
      assert.equal(server.received.filter((p) => p.type === PacketType.DATA).length, 2);

      server.sendContinue(conn.streamId, 5);
      await third;
      await delay(20);
      assert.equal(server.received.filter((p) => p.type === PacketType.DATA).length, 3);
    } finally {
      await transport.close();
      await server.close();
    }
  });

  it('fails pending writes when the stream closes while waiting for credit', async () => {
    const server = await startWispServer({ bufferSize: 1, manualContinue: true });
    const transport = new WispClientTransport({ url: server.url });
    try {
      const conn = await transport.connect({ host: '127.0.0.1', port: echo.port });
      const writer = conn.writable.getWriter();
      await writer.write(new Uint8Array([1]));
      const blocked = writer.write(new Uint8Array([2]));
      await delay(20);
      server.sendClose(conn.streamId, CloseReason.NETWORK_ERROR);
      await assert.rejects(blocked, (e) => isTransportError(e, 'CLOSED'));
    } finally {
      await transport.close();
      await server.close();
    }
  });

  it('maps a BLOCKED close reason to BLOCKED_ADDRESS', async () => {
    const server = await startWispServer({ blockedPorts: [25] });
    const transport = new WispClientTransport({ url: server.url });
    try {
      const conn = await transport.connect({ host: '127.0.0.1', port: 25 });
      await assert.rejects(conn.readable.getReader().read(), (e) =>
        isTransportError(e, 'BLOCKED_ADDRESS'),
      );
      assert.equal(await conn.closed, CloseReason.BLOCKED);
    } finally {
      await transport.close();
      await server.close();
    }
  });

  it('maps a refused connection to CONNECT_REFUSED', async () => {
    const server = await startWispServer();
    const transport = new WispClientTransport({ url: server.url });
    try {
      const port = await unusedPort();
      const conn = await transport.connect({ host: '127.0.0.1', port });
      await assert.rejects(conn.readable.getReader().read(), (e) =>
        isTransportError(e, 'CONNECT_REFUSED'),
      );
      assert.equal(await conn.closed, CloseReason.CONNECTION_REFUSED);
    } finally {
      await transport.close();
      await server.close();
    }
  });

  it('ends the readable cleanly on a VOLUNTARY close from the server', async () => {
    const server = await startWispServer();
    const transport = new WispClientTransport({ url: server.url });
    try {
      const conn = await transport.connect({ host: '127.0.0.1', port: echo.port });
      await delay(20);
      server.sendClose(conn.streamId, CloseReason.VOLUNTARY);
      const result = await conn.readable.getReader().read();
      assert.equal(result.done, true);
    } finally {
      await transport.close();
      await server.close();
    }
  });

  it('times out when the server never sends the initial CONTINUE', async () => {
    const server = await startWispServer({ silent: true });
    const transport = new WispClientTransport({ url: server.url, connectTimeoutMs: 100 });
    try {
      const started = Date.now();
      await assert.rejects(transport.connect({ host: '127.0.0.1', port: echo.port }), (e) =>
        isTransportError(e, 'CONNECT_TIMEOUT'),
      );
      assert.ok(Date.now() - started < 2000);
    } finally {
      await transport.close();
      await server.close();
    }
  });

  it('reports CONNECT_REFUSED when the Wisp server is unreachable', async () => {
    const port = await unusedPort();
    const transport = new WispClientTransport({ url: `ws://127.0.0.1:${port}/` });
    await assert.rejects(transport.connect({ host: 'example.com', port: 80 }), (e) =>
      isTransportError(e, 'CONNECT_REFUSED'),
    );
    await transport.close();
  });

  it('errors open streams with CLOSED when the WebSocket drops, then reconnects', async () => {
    const server = await startWispServer();
    const transport = new WispClientTransport({ url: server.url });
    try {
      const conn = await transport.connect({ host: '127.0.0.1', port: echo.port });
      const read = conn.readable.getReader().read();
      await server.close();
      await assert.rejects(read, (e) => isTransportError(e, 'CLOSED'));
    } finally {
      await transport.close();
    }

    const second = await startWispServer();
    const t2 = new WispClientTransport({ url: second.url });
    try {
      const a = await t2.connect({ host: '127.0.0.1', port: echo.port });
      await a.close();
      const b = await t2.connect({ host: '127.0.0.1', port: echo.port });
      await b.close();
    } finally {
      await t2.close();
      await second.close();
    }
  });

  it('rejects TLS targets and invalid ports', async () => {
    const transport = new WispClientTransport({ url: 'ws://127.0.0.1:1/' });
    await assert.rejects(transport.connect({ host: 'example.com', port: 443, tls: true }), (e) =>
      isTransportError(e, 'PROTOCOL'),
    );
    await assert.rejects(transport.connect({ host: 'example.com', port: 0 }), (e) =>
      isTransportError(e, 'BLOCKED_PORT'),
    );
    await transport.close();
    await assert.rejects(transport.connect({ host: 'example.com', port: 80 }), (e) =>
      isTransportError(e, 'CLOSED'),
    );
  });

  it('requires a url', () => {
    assert.throws(() => new WispClientTransport({ url: '' }), TypeError);
  });
});
