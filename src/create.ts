import { DirectTransport } from './direct.ts';
import { AddressPolicy } from './policy.ts';
import type { Transport } from './types.ts';
import { WispClientTransport } from './wisp/client.ts';

/** The `transport` section of an Iridium config file. */
export interface TransportConfig {
  type: 'wisp' | 'direct';
  /** Path of the Wisp endpoint on an Iridium server. Used by servers, not by this client. */
  wispPath?: string;
  /** Full WebSocket URL of the Wisp server. Required when `type` is "wisp". */
  url?: string;
}

/** The `security` section of an Iridium config file. */
export interface TransportSecurityConfig {
  blockPrivateAddresses?: boolean;
  blockedPorts?: readonly number[];
  allowedPorts?: readonly number[];
}

export interface CreateTransportOptions {
  security?: TransportSecurityConfig;
  /** Connect timeout for either transport type, in milliseconds. */
  connectTimeoutMs?: number;
}

/**
 * Build a transport from config: `createTransport(config.transport, { security: config.security })`.
 * Security settings apply to the direct transport; a Wisp server enforces its own policy.
 */
export function createTransport(
  config: TransportConfig,
  options: CreateTransportOptions = {},
): Transport {
  switch (config?.type) {
    case 'direct':
      return new DirectTransport({
        policy: new AddressPolicy({
          blockPrivateAddresses: options.security?.blockPrivateAddresses,
          blockedPorts: options.security?.blockedPorts,
          allowedPorts: options.security?.allowedPorts,
        }),
        connectTimeoutMs: options.connectTimeoutMs,
      });
    case 'wisp':
      if (!config.url) {
        throw new TypeError('transport.url is required when transport.type is "wisp"');
      }
      return new WispClientTransport({
        url: config.url,
        connectTimeoutMs: options.connectTimeoutMs,
      });
    default:
      throw new TypeError(
        `Unknown transport type: ${String((config as { type?: unknown })?.type)}`,
      );
  }
}
