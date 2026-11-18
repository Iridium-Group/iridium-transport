/**
 * Start the test Wisp server and a TCP echo server on 127.0.0.1, then talk to the echo
 * server through WispClientTransport. Everything stays on this machine.
 *
 *   node examples/wisp-local.ts
 */
import { WispClientTransport } from '../src/index.ts';
import { startEchoServer } from '../test/fixtures/tcp.ts';
import { startWispServer } from '../test/fixtures/wisp-server.ts';

const echo = await startEchoServer();
const server = await startWispServer({ bufferSize: 4 });
console.log(`Wisp test server listening at ${server.url}`);

const transport = new WispClientTransport({ url: server.url });
try {
  const conn = await transport.connect({ host: '127.0.0.1', port: echo.port });
  console.log(`opened Wisp stream ${conn.streamId} to 127.0.0.1:${echo.port}`);

  const writer = conn.writable.getWriter();
  const reader = conn.readable.getReader();
  const decoder = new TextDecoder();
  for (let i = 1; i <= 6; i++) {
    await writer.write(new TextEncoder().encode(`message ${i}`));
    const { value } = await reader.read();
    console.log(`echo: ${decoder.decode(value)}`);
  }
  reader.releaseLock();
  await conn.close();
  console.log(`stream closed with reason 0x${(await conn.closed).toString(16).padStart(2, '0')}`);
} finally {
  await transport.close();
  await server.close();
  await echo.close();
}
