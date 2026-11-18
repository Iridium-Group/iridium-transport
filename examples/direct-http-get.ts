/**
 * Fetch http://example.com/ over a raw TCP connection opened by DirectTransport.
 * The default address policy is active, so private targets would be refused.
 *
 *   node examples/direct-http-get.ts [host]
 */
import { DirectTransport } from '../src/index.ts';

const host = process.argv[2] ?? 'example.com';
const transport = new DirectTransport({ connectTimeoutMs: 5000 });

try {
  const conn = await transport.connect({ host, port: 80 });
  console.log(`connected to ${conn.info.remoteHost} via ${conn.info.remoteAddress}`);

  const writer = conn.writable.getWriter();
  await writer.write(
    new TextEncoder().encode(`GET / HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`),
  );
  writer.releaseLock();

  let response = '';
  const decoder = new TextDecoder();
  for await (const chunk of conn.readable) response += decoder.decode(chunk, { stream: true });
  const [head = ''] = response.split('\r\n\r\n');
  console.log(head);
  console.log(`(${response.length} bytes total)`);
} finally {
  await transport.close();
}
