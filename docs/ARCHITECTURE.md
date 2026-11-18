# Architecture

`@iridium-group/transport` gives proxy and networking code one way to open a byte stream to a
`host:port`, whatever actually carries the bytes.

## Layers

```
  +---------------------+
  |  Client code        |   HTTP client, proxy engine, test
  +----------+----------+
             | connect({ host, port, tls? })
             v
  +---------------------+
  |  Transport          |   interface: name, connect(), close()
  |                     |
  |  DirectTransport ---+--> AddressPolicy --> DNS lookup --> node:net / node:tls ----+
  |                     |                                                           |
  |  WispClientTransport+--> WebSocket --> Wisp server --> TCP socket ---------------+
  |                     |                                                           |
  |  MemoryTransport ---+--> in-process handler (tests)                             |
  +----------+----------+                                                           |
             | Connection { readable, writable, info, close() }                     |
             v                                                                      v
  +---------------------+                                               +-------------------+
  |  Client code reads  |                                               |  Target           |
  |  and writes bytes   | <-------------------------------------------> |  host:port        |
  +---------------------+                                               +-------------------+
```

Every implementation returns the same `Connection`: a `ReadableStream<Uint8Array>`, a
`WritableStream<Uint8Array>`, an `info` object, and `close()`. Errors are `TransportError`
instances with a stable `code`.

## DirectTransport connection flow

```
connect(target)
  |
  |- policy.checkPort(port)            invalid / blocked / not allowed -> BLOCKED_PORT
  |- policy.resolve(host)
  |     |- IP literal: check it        private -> BLOCKED_ADDRESS
  |     '- hostname: lookup all answers
  |           no answer / DNS error    -> CONNECT_REFUSED
  |           any answer private       -> BLOCKED_ADDRESS
  |           otherwise pick the first answer
  |- net.connect / tls.connect to the picked address (not the hostname)
  |     TLS: servername = original hostname (SNI and certificate check)
  |- wait for 'connect' or 'secureConnect'
  |     timer fires                    -> CONNECT_TIMEOUT
  |     ECONNREFUSED, EHOSTUNREACH...  -> CONNECT_REFUSED
  |     signal aborted                 -> CLOSED
  '- wrap the socket in web streams (backpressure in both directions)
```

Connecting to the checked address is what makes the check meaningful. If the socket were opened
to the hostname, the operating system would resolve it again and could get a different, private
answer (DNS rebinding).

Rejecting a hostname when _any_ of its answers is private is stricter than checking only the
first answer, and is deliberate: a public name has no reason to publish a private record.

### Address ranges treated as private

IPv4: `0.0.0.0/8`, `10.0.0.0/8`, `100.64.0.0/10`, `127.0.0.0/8`, `169.254.0.0/16` (includes the
cloud metadata address `169.254.169.254`), `172.16.0.0/12`, `192.0.0.0/24`, `192.0.2.0/24`,
`192.88.99.0/24`, `192.168.0.0/16`, `198.18.0.0/15`, `198.51.100.0/24`, `203.0.113.0/24`,
`224.0.0.0/4`, `240.0.0.0/4`.

IPv6: `::/96` (unspecified, loopback, IPv4-compatible), `::ffff:0:0/96` (IPv4-mapped, always),
`::ffff:0:0:0/96`, `64:ff9b::/96` when the embedded IPv4 address is private, `64:ff9b:1::/48`,
`100::/64`, `2001::/32` (Teredo), `2001:db8::/32`, `2002::/16` when the embedded IPv4 address is
private, `3fff::/20`, `fc00::/7` (includes `fd00:ec2::254`), `fe80::/10`, `fec0::/10`, `ff00::/8`.

These checks live in `src/address.ts` and mirror `@iridium-group/utils`.

## Wisp v1

Wisp carries many TCP streams over one WebSocket. This package implements the client side from
the public protocol description at https://github.com/MercuryWorkshop/wisp-protocol.

### Packet format

Every packet is one binary WebSocket message. All integers are little-endian.

| Offset | Size | Field       | Notes                                      |
| ------ | ---- | ----------- | ------------------------------------------ |
| 0      | 1    | Packet type | `0x01` to `0x04`, see below                |
| 1      | 4    | Stream ID   | `uint32`, chosen by the client; 0 = global |
| 5      | n    | Payload     | Depends on packet type                     |

### Packet types

| Type       | Value  | Direction        | Payload                                                                 |
| ---------- | ------ | ---------------- | ----------------------------------------------------------------------- |
| `CONNECT`  | `0x01` | client to server | stream type `uint8` (0x01 TCP, 0x02 UDP), port `uint16`, hostname UTF-8 |
| `DATA`     | `0x02` | both             | raw stream bytes                                                        |
| `CONTINUE` | `0x03` | server to client | buffer remaining `uint32` (packets the client may send)                 |
| `CLOSE`    | `0x04` | both             | close reason `uint8`                                                    |

### Close reasons and error mapping

| Reason | Meaning                                          | Readable stream result        |
| ------ | ------------------------------------------------ | ----------------------------- |
| `0x01` | Unspecified                                      | error `CLOSED`                |
| `0x02` | Voluntary close                                  | ends normally (`done: true`)  |
| `0x03` | Network error                                    | error `CLOSED`                |
| `0x41` | Invalid information (reserved address, bad port) | error `BLOCKED_ADDRESS`       |
| `0x42` | Destination unreachable                          | error `CONNECT_REFUSED`       |
| `0x43` | Connect timed out                                | error `CONNECT_TIMEOUT`       |
| `0x44` | Connection refused                               | error `CONNECT_REFUSED`       |
| `0x47` | Data transfer timed out                          | error `CLOSED`                |
| `0x48` | Blocked by the server                            | error `BLOCKED_ADDRESS`       |
| `0x49` | Throttled                                        | error `CLOSED`                |
| `0x81` | Client error (client only)                       | sent by clients, not received |

### Session and flow control

```
client                                   server
  | ---- WebSocket handshake ------------> |
  | <--- CONTINUE stream=0 buffer=N ------ |   initial per-stream buffer size
  | ---- CONNECT stream=s host port -----> |   data may follow immediately
  | ---- DATA stream=s ------------------> |   credit for s: N-1
  | ---- DATA stream=s ------------------> |   ...
  |        (credit reaches 0: writes wait)  |
  | <--- CONTINUE stream=s buffer=N ------ |   credit reset to N
  | <--- DATA stream=s ------------------- |   no flow control in this direction
  | ---- CLOSE stream=s reason=0x02 -----> |   or the server sends CLOSE
```

- The WebSocket is opened on the first `connect()` and shared by every stream. If it drops, open
  streams error with `CLOSED` and the next `connect()` opens a new one.
- `connectTimeoutMs` covers opening the WebSocket and receiving the initial CONTINUE.
- `connect()` resolves as soon as CONNECT is sent, as the protocol allows. A refused or blocked
  target shows up as an error on the readable side.
- Stream IDs are random non-zero `uint32` values, unique within the session.
- Packets of unknown types are ignored, so a future server extension does not break the client.

### Test server

`test/fixtures/wisp-server.ts` is a minimal Wisp server used by the tests and by
`examples/wisp-local.ts`. It sits on `node:http` and a small RFC 6455 implementation in
`test/fixtures/websocket.ts`, forwards streams to real TCP sockets, and can be configured to
block ports, withhold CONTINUE packets, or stay silent, so flow control, close reasons and timeouts
can be tested. It does not apply an address policy and is not meant for production.
