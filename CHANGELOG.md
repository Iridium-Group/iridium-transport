# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.1.0 — 2026-11-19

### Added

- `Transport`, `Connection`, `TransportTarget`, `ConnectOptions` and `ConnectionInfo` types based on web streams.
- `TransportError` with codes `BLOCKED_ADDRESS`, `BLOCKED_PORT`, `CONNECT_TIMEOUT`, `CONNECT_REFUSED`, `CLOSED` and `PROTOCOL`.
- `DirectTransport` for TCP and TLS over Node `net`/`tls`, with connect timeouts, abort signals and connections pinned to the policy-checked address.
- `AddressPolicy` with private-address blocking, default blocked ports 25, 465 and 587, optional allowed ports, and a pluggable DNS lookup.
- Private and special-purpose address checks for IPv4 and IPv6 (`isPrivateIPv4`, `isPrivateIPv6`, `isPrivateAddress`).
- Wisp v1 packet encoding and decoding, and `WispClientTransport` with stream multiplexing, CONTINUE-based flow control and close-reason mapping.
- `MemoryTransport`, `createConnectionPair` and `echoHandler` for tests.
- `createTransport` for the `transport` section of an Iridium config.
- Test suite with a minimal Wisp test server, runnable examples, and architecture and API documentation.
