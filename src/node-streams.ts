import type { Socket } from 'node:net';
import { TransportError } from './errors.ts';

/** Queue up to this many chunks before pausing the socket. */
const READ_HIGH_WATER_MARK = 16;

/** Wrap a connected Node socket in web streams with backpressure in both directions. */
export function socketToStreams(socket: Socket): {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
} {
  let readDone = false;
  const readable = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        socket.on('data', (chunk: Buffer) => {
          if (readDone) return;
          controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
          if ((controller.desiredSize ?? 0) <= 0) socket.pause();
        });
        socket.on('end', () => {
          if (readDone) return;
          readDone = true;
          controller.close();
        });
        socket.on('error', (cause: Error) => {
          if (readDone) return;
          readDone = true;
          controller.error(new TransportError('CLOSED', 'Connection error', { cause }));
        });
        socket.on('close', () => {
          if (readDone) return;
          readDone = true;
          controller.close();
        });
      },
      pull() {
        socket.resume();
      },
      cancel() {
        readDone = true;
        socket.destroy();
      },
    },
    { highWaterMark: READ_HIGH_WATER_MARK },
  );

  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      return new Promise<void>((resolve, reject) => {
        if (socket.destroyed || !socket.writable) {
          reject(new TransportError('CLOSED', 'Connection is closed'));
          return;
        }
        socket.write(chunk, (err) => {
          if (err) reject(new TransportError('CLOSED', 'Write failed', { cause: err }));
          else resolve();
        });
      });
    },
    close() {
      return new Promise<void>((resolve) => {
        if (socket.destroyed || !socket.writable) {
          resolve();
          return;
        }
        socket.end(() => resolve());
      });
    },
    abort() {
      socket.destroy();
    },
  });

  return { readable, writable };
}
