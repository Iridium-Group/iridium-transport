import { lookup as dnsLookup } from 'node:dns/promises';
import { ipVersion, isPrivateAddress } from './address.ts';
import { TransportError } from './errors.ts';

/** Ports blocked by default: SMTP submission and relay, to keep proxies from sending mail. */
export const DEFAULT_BLOCKED_PORTS: readonly number[] = [25, 465, 587];

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/** Resolves a hostname to every address it has. Matches the shape of `dns.promises.lookup(host, { all: true })`. */
export type LookupFunction = (hostname: string) => Promise<ResolvedAddress[]>;

export interface AddressPolicyOptions {
  /** Reject targets that resolve to private or special-purpose addresses. Default true. */
  blockPrivateAddresses?: boolean;
  /** Ports that are always rejected. Default [25, 465, 587]. */
  blockedPorts?: readonly number[];
  /** When set, only these ports are accepted. */
  allowedPorts?: readonly number[];
  /** Replace DNS resolution, for tests or custom resolvers. */
  lookup?: LookupFunction;
}

const defaultLookup: LookupFunction = async (hostname) => {
  const answers = await dnsLookup(hostname, { all: true, verbatim: true });
  return answers.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));
};

function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

/**
 * Decides whether a target may be connected to, and pins it to one validated address.
 *
 * `resolve()` looks the host up, rejects the target if any answer is private (so a hostname
 * with one public and one private record is refused), and returns the address to connect to.
 * Connecting to that exact address, instead of the hostname, closes the window in which a
 * second DNS lookup could return a different answer.
 */
export class AddressPolicy {
  readonly blockPrivateAddresses: boolean;
  readonly blockedPorts: ReadonlySet<number>;
  readonly allowedPorts: ReadonlySet<number> | undefined;
  readonly #lookup: LookupFunction;

  constructor(options: AddressPolicyOptions = {}) {
    this.blockPrivateAddresses = options.blockPrivateAddresses ?? true;
    this.blockedPorts = new Set(options.blockedPorts ?? DEFAULT_BLOCKED_PORTS);
    this.allowedPorts = options.allowedPorts ? new Set(options.allowedPorts) : undefined;
    this.#lookup = options.lookup ?? defaultLookup;
  }

  /** Throws `TransportError('BLOCKED_PORT')` unless `port` is valid and permitted. */
  checkPort(port: number): void {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new TransportError('BLOCKED_PORT', `Invalid port: ${String(port)}`);
    }
    if (this.blockedPorts.has(port)) {
      throw new TransportError('BLOCKED_PORT', `Port ${port} is blocked`);
    }
    if (this.allowedPorts && !this.allowedPorts.has(port)) {
      throw new TransportError('BLOCKED_PORT', `Port ${port} is not in the allowed list`);
    }
  }

  /** Throws `TransportError('BLOCKED_ADDRESS')` when `address` is private and private addresses are blocked. */
  checkAddress(address: string): void {
    if (this.blockPrivateAddresses && isPrivateAddress(address)) {
      throw new TransportError('BLOCKED_ADDRESS', `Address ${address} is not allowed`);
    }
  }

  /**
   * Resolve `host` and return the single address to connect to.
   * Throws BLOCKED_ADDRESS for private answers and CONNECT_REFUSED when the host does not resolve.
   */
  async resolve(host: string): Promise<ResolvedAddress> {
    const bare = stripBrackets(host.trim());
    if (bare.length === 0) {
      throw new TransportError('CONNECT_REFUSED', 'Empty host');
    }
    const literal = ipVersion(bare);
    if (literal !== 0) {
      this.checkAddress(bare);
      return { address: bare, family: literal };
    }

    let answers: ResolvedAddress[];
    try {
      answers = await this.#lookup(bare);
    } catch (cause) {
      throw new TransportError('CONNECT_REFUSED', `Could not resolve ${bare}`, { cause });
    }
    if (answers.length === 0) {
      throw new TransportError('CONNECT_REFUSED', `No addresses found for ${bare}`);
    }
    for (const answer of answers) {
      if (ipVersion(answer.address) === 0) {
        throw new TransportError(
          'BLOCKED_ADDRESS',
          `Resolver returned an invalid address for ${bare}`,
        );
      }
      if (this.blockPrivateAddresses && isPrivateAddress(answer.address)) {
        throw new TransportError(
          'BLOCKED_ADDRESS',
          `${bare} resolves to ${answer.address}, which is not allowed`,
        );
      }
    }
    const first = answers[0] as ResolvedAddress;
    return { address: first.address, family: first.family };
  }

  /** Check the port, then resolve the host. */
  async check(target: { host: string; port: number }): Promise<ResolvedAddress> {
    this.checkPort(target.port);
    return this.resolve(target.host);
  }
}
