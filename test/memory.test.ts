import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isTransportError } from '../src/errors.ts';
import { MemoryTransport, createConnectionPair, echoHandler } from '../src/memory.ts';
import { readAll, readExactly } from './fixtures/tcp.ts';

const text = new TextEncoder();
const fromText = new TextDecoder();

describe('createConnectionPair', () => {
  it('passes bytes both ways and copies chunks', async () => {
    const [a, b] = createConnectionPair();
    const buf = text.encode('abc');
    const wa = a.writable.getWriter();
    await wa.write(buf);
    buf[0] = 0x7a;
    assert.equal(fromText.decode(await readExactly(b.readable.getReader(), 3)), 'abc');
    const wb = b.writable.getWriter();
    await wb.write(text.encode('xyz'));
    assert.equal(fromText.decode(await readExactly(a.readable.getReader(), 3)), 'xyz');
  });

  it('ends the peer readable when the writable closes', async () => {
    const [a, b] = createConnectionPair();
    const w = a.writable.getWriter();
    await w.write(text.encode('done'));
    await w.close();
    assert.equal(fromText.decode(await readAll(b.readable)), 'done');
  });

  it('rejects writes after close', async () => {
    const [a] = createConnectionPair();
    const w = a.writable.getWriter();
    await a.close();
    await assert.rejects(w.write(text.encode('x')), (e) => isTransportError(e, 'CLOSED'));
  });
});

describe('MemoryTransport', () => {
  it('connects to a listener and echoes', async () => {
    const transport = new MemoryTransport();
    transport.listen('echo.local', 7, echoHandler);
    const conn = await transport.connect({ host: 'ECHO.local', port: 7 });
    assert.equal(conn.info.remotePort, 7);
    const writer = conn.writable.getWriter();
    await writer.write(text.encode('hello'));
    assert.equal(fromText.decode(await readExactly(conn.readable.getReader(), 5)), 'hello');
    await transport.close();
  });

  it('refuses unknown targets and invalid ports', async () => {
    const transport = new MemoryTransport();
    await assert.rejects(transport.connect({ host: 'nowhere', port: 1 }), (e) =>
      isTransportError(e, 'CONNECT_REFUSED'),
    );
    await assert.rejects(transport.connect({ host: 'nowhere', port: 0 }), (e) =>
      isTransportError(e, 'BLOCKED_PORT'),
    );
  });

  it('stops listening and rejects duplicate listeners', async () => {
    const transport = new MemoryTransport();
    const stop = transport.listen('a', 1, echoHandler);
    assert.throws(() => transport.listen('a', 1, echoHandler));
    stop();
    await assert.rejects(transport.connect({ host: 'a', port: 1 }), (e) =>
      isTransportError(e, 'CONNECT_REFUSED'),
    );
  });

  it('closes connections on close() and refuses new ones', async () => {
    const transport = new MemoryTransport();
    transport.listen('a', 1, () => undefined);
    const conn = await transport.connect({ host: 'a', port: 1 });
    await transport.close();
    assert.equal((await conn.readable.getReader().read()).done, true);
    await assert.rejects(transport.connect({ host: 'a', port: 1 }), (e) =>
      isTransportError(e, 'CLOSED'),
    );
  });
});
