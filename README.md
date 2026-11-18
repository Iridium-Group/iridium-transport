<p align="center"><img src="./.github/assets/iridium-mark.svg" width="96" alt="Iridium Group"></p>

<h1 align="center">iridium-transport</h1>

<p align="center">
  <a href="https://github.com/Iridium-Group/iridium-transport/actions/workflows/ci.yml"><img src="https://github.com/Iridium-Group/iridium-transport/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT"></a>
</p>

A small transport abstraction for browser-based networking and proxy applications. One interface,
three implementations: direct TCP/TLS from Node with an address policy, a Wisp v1 client that
multiplexes TCP streams over a WebSocket, and an in-memory transport for tests.

Part of [Iridium Group](https://github.com/Iridium-Group): open web infrastructure for
browser-based networking and proxy applications.

**Status: Experimental.** Version 0.1.0. The API may change before 1.0. Not yet published to npm.

## Contents

- [Features](#features)
- [Install](#install)
- [Usage](#usage)
- [Examples](#examples)
- [Security model](#security-model)
- [Limitations](#limitations)
- [Development](#development)
- [Documentation](#documentation)
- [Dependencies and licenses](#dependencies-and-licenses)
- [Acknowledgements](#acknowledgements)
- [License](#license)

## Features

- `Transport` and `Connection` interfaces built on web streams (`ReadableStream` / `WritableStream`).
- `DirectTransport`: Node `net`/`tls` connections. Every target is resolved and checked by an
  `AddressPolicy` first, and the socket is opened to the validated address so a second DNS
  lookup cannot swap in a different one.
- `AddressPolicy`: blocks private and special-purpose addresses (loopback, RFC 1918, CGNAT,
  link-local, cloud metadata, IPv6 unique local, IPv4-mapped, NAT64/6to4 to private, and more),
  blocked ports (25, 465, 587 by default), and an optional allow list of ports.
- `WispClientTransport`: an independent implementation of the Wisp v1 client: CONNECT, DATA,
  CONTINUE and CLOSE framing, per-stream flow control, and close reasons mapped to error codes.
  Uses the global `WebSocket`, so it runs in browsers and in Node 22+.
- `MemoryTransport`: connected in-process pairs for tests.
- `TransportError` with a stable `code`: `BLOCKED_ADDRESS`, `BLOCKED_PORT`, `CONNECT_TIMEOUT`,
  `CONNECT_REFUSED`, `CLOSED`, `PROTOCOL`.
- `createTransport(config.transport, { security })` for Iridium config files.
- Zero runtime dependencies. ESM only. TypeScript types included.

## Install

The package is not on npm yet. Install it from GitHub; the `prepare` script builds `dist/`:

```sh
npm install github:Iridium-Group/iridium-transport
```

Requires Node.js 22.18 or newer.

## Usage

### Direct TCP with the default address policy

```ts
import { DirectTransport, TransportError } from '@iridium-group/transport';

const transport = new DirectTransport({ connectTimeoutMs: 5000 });
try {
  const conn = await transport.connect({ host: 'example.com', port: 80 });
  const writer = conn.writable.getWriter();
  await writer.write(new TextEncoder().encode('HEAD / HTTP/1.1\r\nHost: example.com\r\n\r\n'));
  const { value } = await conn.readable.getReader().read();
  console.log(new TextDecoder().decode(value));
  await conn.close();
} catch (error) {
  if (error instanceof TransportError) console.error(error.code, error.message);
  else throw error;
} finally {
  await transport.close();
}
```

`await transport.connect({ host: '127.0.0.1', port: 22 })` rejects with
`TransportError { code: 'BLOCKED_ADDRESS' }`.

### Wisp

```ts
import { WispClientTransport } from '@iridium-group/transport';

const transport = new WispClientTransport({ url: 'wss://wisp.example.org/wisp/' });
const conn = await transport.connect({ host: 'example.com', port: 80 });
```

The Wisp server decides which targets are allowed; a refusal arrives as a CLOSE packet and
surfaces as an error on `conn.readable` (for example `BLOCKED_ADDRESS` for close reason 0x48).

### From an Iridium config

```ts
import { createTransport } from '@iridium-group/transport';

const transport = createTransport(config.transport, { security: config.security });
```

### Subpath imports

`@iridium-group/transport/wisp`, `@iridium-group/transport/memory` and
`@iridium-group/transport/address` do not import any `node:` module, so they can be bundled for
browsers. The root entry also exports `DirectTransport` and `AddressPolicy`, which need Node.

## Examples

Run from a clone of this repository after `npm ci`:

```sh
node examples/memory-echo.ts      # in-process echo, no network
node examples/wisp-local.ts       # Wisp client against the local test server
node examples/direct-http-get.ts  # HTTP GET to example.com over DirectTransport (needs internet)
```

## Security model

- `DirectTransport` checks the port, resolves the host, and rejects the target if any DNS answer
  is private, before any socket is opened. The socket then connects to the checked address, with
  the original hostname used only for TLS SNI and certificate verification.
- IP literals are checked directly. Input that is not a valid address is treated as private.
- `WispClientTransport` does not apply an address policy: the Wisp server is the party that opens
  sockets and must enforce its own rules.
- See [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) for details.

To report a vulnerability, use GitHub private vulnerability reporting ("Report a vulnerability" on
this repository's Security tab). There is no security email address yet.

## Limitations

- Wisp: TCP streams only. UDP streams, Wisp v2 extensions and TLS over Wisp are not implemented.
  Targets with `tls: true` are rejected with a `PROTOCOL` error.
- Wisp v1 has no half-close. Closing a connection's `writable` stops further writes but leaves the
  stream open for reading until either side closes it.
- Wisp v1 has no flow control from server to client; incoming data is queued until read.
- The address checks in `src/address.ts` mirror `@iridium-group/utils`. This package will import
  them from utils once that package is installable, keeping the same function signatures.

## Development

```sh
npm ci
npm run format:check
npm run typecheck
npm test
npm run build
```

Tests use the built-in `node --test` runner and run the TypeScript sources directly. The Wisp tests
use a minimal Wisp server in `test/fixtures/wisp-server.ts`, built on `node:http` and a small
WebSocket implementation in `test/fixtures/websocket.ts`, so no extra dev dependency is needed.
These fixtures are for tests and examples only.

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## Documentation

- [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md): layers, connection flow, Wisp framing.
- [docs/API.md](./docs/API.md): every exported class, function and type.
- [CHANGELOG.md](./CHANGELOG.md)

## Dependencies and licenses

Runtime dependencies: none.

Development dependencies:

| Package       | License    | Used for                 |
| ------------- | ---------- | ------------------------ |
| `typescript`  | Apache-2.0 | Type checking and build  |
| `@types/node` | MIT        | Node.js type definitions |
| `prettier`    | MIT        | Formatting               |

## Acknowledgements

The Wisp protocol is designed and documented by Mercury Workshop
([wisp-protocol](https://github.com/MercuryWorkshop/wisp-protocol), protocol author ading2210).
This package implements the client side independently from that public description and contains
no code from Mercury Workshop projects.

## License

[MIT](./LICENSE) © 2026 Iridium Group contributors
