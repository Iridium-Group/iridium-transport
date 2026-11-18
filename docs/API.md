# API reference

All exports come from `@iridium-group/transport`. The browser-safe subsets are also available as
`@iridium-group/transport/wisp`, `@iridium-group/transport/memory` and
`@iridium-group/transport/address`.

## Types

### `TransportTarget`

| Field  | Type      | Notes                                                        |
| ------ | --------- | ------------------------------------------------------------ |
| `host` | `string`  | Hostname, IPv4 literal, or IPv6 literal (brackets accepted). |
| `port` | `number`  | 1 to 65535.                                                  |
| `tls`  | `boolean` | Optional. Supported by `DirectTransport` only.               |

### `ConnectOptions`

| Field       | Type          | Notes                                                        |
| ----------- | ------------- | ------------------------------------------------------------ |
| `signal`    | `AbortSignal` | Aborts the attempt (`CLOSED`), or closes an open connection. |
| `timeoutMs` | `number`      | Overrides the transport's connect timeout for this call.     |

### `Connection`

| Member     | Type                         | Notes                                                                      |
| ---------- | ---------------------------- | -------------------------------------------------------------------------- |
| `readable` | `ReadableStream<Uint8Array>` | Bytes from the target.                                                     |
| `writable` | `WritableStream<Uint8Array>` | Bytes to the target.                                                       |
| `info`     | `ConnectionInfo`             | `remoteHost`, `remotePort`, `remoteAddress?`, `openedAt` (ms since epoch). |
| `close()`  | `Promise<void>`              | Closes both directions. Idempotent.                                        |

### `Transport`

| Member                      | Type                  |
| --------------------------- | --------------------- |
| `name`                      | `string`              |
| `connect(target, options?)` | `Promise<Connection>` |
| `close()`                   | `Promise<void>`       |

`close()` closes every connection the transport opened; later `connect()` calls reject with `CLOSED`.

## Errors

### `class TransportError extends Error`

`new TransportError(code, message, { cause? })`. Properties: `code`, `name` (`'TransportError'`),
`message`, `cause`.

| Code              | When                                                                                              |
| ----------------- | ------------------------------------------------------------------------------------------------- |
| `BLOCKED_ADDRESS` | Target is (or resolves to) a disallowed address, or a Wisp server sent close reason 0x41 or 0x48. |
| `BLOCKED_PORT`    | Port is invalid, blocked, or not on the allow list.                                               |
| `CONNECT_TIMEOUT` | Not connected within the timeout, or Wisp close reason 0x43.                                      |
| `CONNECT_REFUSED` | Refused, unreachable, did not resolve, or Wisp close reason 0x42/0x44.                            |
| `CLOSED`          | Transport or connection closed, aborted, or dropped.                                              |
| `PROTOCOL`        | Malformed Wisp data, or an unsupported feature such as TLS over Wisp.                             |

- `TRANSPORT_ERROR_CODES`: the list above, in that order.
- `isTransportError(value, code?)`: type guard, optionally for one code.

## DirectTransport

```ts
new DirectTransport(options?: {
  policy?: AddressPolicy;        // default: new AddressPolicy()
  connectTimeoutMs?: number;     // default: 10000 (DEFAULT_CONNECT_TIMEOUT_MS)
  tls?: { ca?, rejectUnauthorized?, ALPNProtocols?, minVersion? };
})
```

Node only. `name` is `'direct'`. Exposes `policy` and `connectTimeoutMs`. `info.remoteAddress` is
the address the socket was opened to.

## AddressPolicy

```ts
new AddressPolicy(options?: {
  blockPrivateAddresses?: boolean;   // default true
  blockedPorts?: readonly number[];  // default [25, 465, 587] (DEFAULT_BLOCKED_PORTS)
  allowedPorts?: readonly number[];  // when set, only these ports pass
  lookup?: LookupFunction;           // default: dns.promises.lookup(host, { all: true })
})
```

| Method                  | Returns                    | Throws                               |
| ----------------------- | -------------------------- | ------------------------------------ |
| `checkPort(port)`       | `void`                     | `BLOCKED_PORT`                       |
| `checkAddress(ip)`      | `void`                     | `BLOCKED_ADDRESS`                    |
| `resolve(host)`         | `Promise<ResolvedAddress>` | `BLOCKED_ADDRESS`, `CONNECT_REFUSED` |
| `check({ host, port })` | `Promise<ResolvedAddress>` | all of the above                     |

`ResolvedAddress` is `{ address: string; family: 4 | 6 }`. `LookupFunction` is
`(hostname: string) => Promise<ResolvedAddress[]>`.

## Address helpers

| Function               | Returns                | Notes                                                    |
| ---------------------- | ---------------------- | -------------------------------------------------------- |
| `isPrivateIPv4(ip)`    | `boolean`              | False for non-IPv4 input.                                |
| `isPrivateIPv6(ip)`    | `boolean`              | False for non-IPv6 input. Accepts brackets and zone ids. |
| `isPrivateAddress(ip)` | `boolean`              | Either family. True for invalid input (fails closed).    |
| `ipVersion(input)`     | `0 \| 4 \| 6`          |                                                          |
| `parseIPv4(input)`     | `[n, n, n, n] \| null` | Strict dotted quad, no leading zeros.                    |
| `parseIPv6(input)`     | `number[] \| null`     | Eight 16-bit groups.                                     |

The ranges are listed in [ARCHITECTURE.md](./ARCHITECTURE.md#address-ranges-treated-as-private).

## WispClientTransport

```ts
new WispClientTransport(options: {
  url: string;                       // ws:// or wss:// URL, ending in "/"
  WebSocket?: WebSocketConstructor;  // default: globalThis.WebSocket
  connectTimeoutMs?: number;         // default 10000 (DEFAULT_WISP_CONNECT_TIMEOUT_MS)
})
```

`name` is `'wisp'`. `connect()` resolves to a `WispConnection`, which adds:

| Member     | Type              | Notes                                                  |
| ---------- | ----------------- | ------------------------------------------------------ |
| `streamId` | `number`          | The Wisp stream ID.                                    |
| `closed`   | `Promise<number>` | Resolves with the close reason when the stream closes. |

Targets with `tls: true` reject with `PROTOCOL`. Closing `writable` does not close the stream
(Wisp v1 has no half-close); call `close()`.

## Wisp packets

| Export                                 | Description                                                                              |
| -------------------------------------- | ---------------------------------------------------------------------------------------- |
| `PacketType`                           | `{ CONNECT: 1, DATA: 2, CONTINUE: 3, CLOSE: 4 }`                                         |
| `StreamType`                           | `{ TCP: 1, UDP: 2 }`                                                                     |
| `CloseReason`                          | Named close reasons, see ARCHITECTURE.md.                                                |
| `HEADER_LENGTH`, `MAX_STREAM_ID`       | `5`, `0xffffffff`                                                                        |
| `encodeConnect(id, host, port, type?)` | `Uint8Array`                                                                             |
| `encodeData(id, payload)`              | `Uint8Array`                                                                             |
| `encodeContinue(id, bufferRemaining)`  | `Uint8Array`                                                                             |
| `encodeClose(id, reason)`              | `Uint8Array`                                                                             |
| `encodePacket(packet)`                 | `Uint8Array` for any `WispPacket`                                                        |
| `decodePacket(bytes)`                  | `WispPacket`; throws `PROTOCOL` when malformed; unknown types return `{ unknown: true }` |
| `closeReasonToErrorCode(reason)`       | Matching `TransportErrorCode`                                                            |
| `closeReasonName(reason)`              | e.g. `'BLOCKED'`, or `'0x99'` when unknown                                               |

Encoders throw `RangeError` for out-of-range fields.

## MemoryTransport

```ts
const t = new MemoryTransport();
const stop = t.listen('echo.internal', 7, echoHandler);
const conn = await t.connect({ host: 'echo.internal', port: 7 });
```

| Export                        | Description                                                                                                                                                             |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MemoryTransport`             | `name` is `'memory'`. `listen(host, port, handler)` returns a function that stops listening. Hosts are case-insensitive. Unknown targets reject with `CONNECT_REFUSED`. |
| `createConnectionPair(info?)` | Two connected `Connection`s. Chunks are copied.                                                                                                                         |
| `echoHandler`                 | A `MemoryHandler` that writes back what it reads.                                                                                                                       |

## createTransport

```ts
createTransport(
  config: { type: 'direct' | 'wisp'; wispPath?: string; url?: string },
  options?: {
    security?: { blockPrivateAddresses?: boolean; blockedPorts?: readonly number[]; allowedPorts?: readonly number[] };
    connectTimeoutMs?: number;
  },
): Transport
```

`'direct'` builds a `DirectTransport` with an `AddressPolicy` from `security`. `'wisp'` builds a
`WispClientTransport` and requires `url`. Anything else throws `TypeError`.
