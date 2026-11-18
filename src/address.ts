/**
 * Private and special-purpose address checks.
 *
 * These mirror the `net` helpers of @iridium-group/utils (isPrivateIPv4, isPrivateIPv6,
 * isPrivateAddress) so this package builds with zero runtime dependencies while utils is
 * not yet installable. Once @iridium-group/utils is available, this module will re-export
 * from it and keep the same signatures.
 *
 * The checks are pure string parsing and work in Node and browsers.
 */

/** Parse a strict dotted-quad IPv4 address into four octets, or return null. */
export function parseIPv4(input: string): [number, number, number, number] | null {
  const parts = input.split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    if (part.length > 1 && part.startsWith('0')) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }
  return octets as [number, number, number, number];
}

/** Parse an IPv6 address (optionally bracketed, with a zone id, or an IPv4 tail) into eight 16-bit groups. */
export function parseIPv6(input: string): number[] | null {
  let text = input.trim();
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1);
  const zone = text.indexOf('%');
  if (zone !== -1) text = text.slice(0, zone);
  if (text.length === 0 || !text.includes(':')) return null;

  let tail: number[] = [];
  const lastColon = text.lastIndexOf(':');
  const maybeV4 = text.slice(lastColon + 1);
  if (maybeV4.includes('.')) {
    const v4 = parseIPv4(maybeV4);
    if (!v4) return null;
    tail = [(v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]];
    text = text.slice(0, lastColon + 1);
    if (!text.endsWith('::')) text = text.slice(0, -1);
  }
  const expected = 8 - tail.length;

  const doubleColon = text.split('::');
  if (doubleColon.length > 2) return null;
  const parseGroups = (segment: string): number[] | null => {
    if (segment === '') return [];
    const groups: number[] = [];
    for (const group of segment.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
      groups.push(parseInt(group, 16));
    }
    return groups;
  };

  const head = parseGroups(doubleColon[0] ?? '');
  if (!head) return null;
  let groups: number[];
  if (doubleColon.length === 2) {
    const rest = parseGroups(doubleColon[1] ?? '');
    if (!rest) return null;
    const missing = expected - head.length - rest.length;
    if (missing < 1) return null;
    groups = [...head, ...new Array<number>(missing).fill(0), ...rest];
  } else {
    groups = head;
  }
  groups = [...groups, ...tail];
  return groups.length === 8 ? groups : null;
}

type V4Range = readonly [number, number, number, number, number];

// [a, b, c, d, prefixLength]
const PRIVATE_V4_RANGES: readonly V4Range[] = [
  [0, 0, 0, 0, 8], // "this" network
  [10, 0, 0, 0, 8], // RFC 1918
  [100, 64, 0, 0, 10], // carrier-grade NAT (RFC 6598)
  [127, 0, 0, 0, 8], // loopback
  [169, 254, 0, 0, 16], // link-local, includes cloud metadata 169.254.169.254
  [172, 16, 0, 0, 12], // RFC 1918
  [192, 0, 0, 0, 24], // IETF protocol assignments
  [192, 0, 2, 0, 24], // TEST-NET-1
  [192, 88, 99, 0, 24], // deprecated 6to4 relay anycast
  [192, 168, 0, 0, 16], // RFC 1918
  [198, 18, 0, 0, 15], // benchmarking
  [198, 51, 100, 0, 24], // TEST-NET-2
  [203, 0, 113, 0, 24], // TEST-NET-3
  [224, 0, 0, 0, 4], // multicast
  [240, 0, 0, 0, 4], // reserved, includes broadcast 255.255.255.255
];

function v4ToInt(o: readonly number[]): number {
  return (((o[0] ?? 0) << 24) | ((o[1] ?? 0) << 16) | ((o[2] ?? 0) << 8) | (o[3] ?? 0)) >>> 0;
}

function v4InRange(value: number, range: V4Range): boolean {
  const prefix = range[4];
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) >>> 0 === (v4ToInt(range) & mask) >>> 0;
}

function isPrivateV4Octets(octets: readonly number[]): boolean {
  const value = v4ToInt(octets);
  return PRIVATE_V4_RANGES.some((range) => v4InRange(value, range));
}

/**
 * True when `ip` is an IPv4 address that should not be reachable from a public proxy:
 * loopback, RFC 1918, carrier-grade NAT, link-local (including 169.254.169.254), documentation,
 * benchmarking, multicast, reserved, and 0.0.0.0/8. False for public addresses and for input
 * that is not an IPv4 address.
 */
export function isPrivateIPv4(ip: string): boolean {
  const octets = parseIPv4(ip);
  return octets !== null && isPrivateV4Octets(octets);
}

/**
 * True when `ip` is an IPv6 address that should not be reachable from a public proxy:
 * unspecified, loopback, IPv4-mapped and IPv4-compatible (always), unique local (fc00::/7,
 * which includes the fd00:ec2::254 metadata address), link-local, site-local, multicast,
 * documentation, discard, Teredo, local-use NAT64, and NAT64 (64:ff9b::/96) or 6to4
 * (2002::/16) addresses that embed a private IPv4 address. False for public addresses and for
 * input that is not an IPv6 address.
 */
export function isPrivateIPv6(ip: string): boolean {
  const g = parseIPv6(ip);
  if (!g) return false;
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = g;
  const embeddedV4 = [g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff];

  // ::/96 covers unspecified (::), loopback (::1) and IPv4-compatible addresses.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return true;
  // ::ffff:0:0/96 IPv4-mapped. Blocked outright: a resolver has no reason to return one.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) return true;
  // ::ffff:0:0:0/96 IPv4-translated (RFC 2765).
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0xffff && g5 === 0) return true;
  // 64:ff9b::/96 well-known NAT64 prefix: check the embedded IPv4 address.
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return isPrivateV4Octets(embeddedV4);
  }
  // 64:ff9b:1::/48 local-use NAT64.
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 1) return true;
  // 100::/64 discard-only.
  if (g0 === 0x100 && g1 === 0 && g2 === 0 && g3 === 0) return true;
  // 2001::/32 Teredo.
  if (g0 === 0x2001 && g1 === 0) return true;
  // 2001:db8::/32 documentation.
  if (g0 === 0x2001 && g1 === 0xdb8) return true;
  // 2002::/16 6to4: the IPv4 address sits in groups 1 and 2.
  if (g0 === 0x2002) return isPrivateV4Octets([g1 >> 8, g1 & 0xff, g2 >> 8, g2 & 0xff]);
  // 3fff::/20 documentation (RFC 9637).
  if ((g0 & 0xfff0) === 0x3ff0) return true;
  // fc00::/7 unique local.
  if ((g0 & 0xfe00) === 0xfc00) return true;
  // fe80::/10 link-local.
  if ((g0 & 0xffc0) === 0xfe80) return true;
  // fec0::/10 site-local (deprecated).
  if ((g0 & 0xffc0) === 0xfec0) return true;
  // ff00::/8 multicast.
  if ((g0 & 0xff00) === 0xff00) return true;
  return false;
}

/**
 * True when `ip` is a private or special-purpose IPv4 or IPv6 address.
 * Fails closed: input that is not a valid IP address also returns true.
 */
export function isPrivateAddress(ip: string): boolean {
  if (parseIPv4(ip)) return isPrivateIPv4(ip);
  if (parseIPv6(ip)) return isPrivateIPv6(ip);
  return true;
}

/** 4 for an IPv4 literal, 6 for an IPv6 literal, 0 otherwise. Brackets are accepted for IPv6. */
export function ipVersion(input: string): 0 | 4 | 6 {
  if (parseIPv4(input)) return 4;
  if (parseIPv6(input)) return 6;
  return 0;
}
