// ─────────────────────────────────────────────────────────────────────────────
// SOCKS5 proxy dispatcher (Fixie)
//
// Coinsbuy requires a static source IP for API access. On Vercel, serverless
// functions run on dynamic AWS IPs, so we route Coinsbuy traffic through a
// Fixie SOCKS5 proxy with a fixed outbound IP.
//
// When FIXIE_URL env var is set (format: `socks5://user:pass@host:port`),
// getProxyDispatcher() returns an undici Dispatcher that routes traffic
// through the proxy. When unset, returns undefined so fetch uses the default
// network stack (useful for local dev without the proxy).
//
// Implementation: opens a raw TCP tunnel via SOCKS5, then layers TLS on top
// for HTTPS destinations (undici + ALPN). Cached after first creation.
// ─────────────────────────────────────────────────────────────────────────────

import { Agent, type Dispatcher } from 'undici';
import { SocksClient } from 'socks';
import tls from 'node:tls';

let cachedDispatcher: Dispatcher | null = null;

interface ParsedProxy {
  host: string;
  port: number;
  username: string;
  password: string;
}

function parseFixieUrl(url: string): ParsedProxy {
  const normalized = url.startsWith('socks') ? url : `socks5://${url}`;
  const u = new URL(normalized);
  return {
    host: u.hostname,
    port: Number(u.port) || 1080,
    username: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
  };
}

/**
 * Returns an undici Dispatcher that routes traffic through the Fixie SOCKS5
 * proxy when FIXIE_URL is set, otherwise returns undefined.
 *
 * Pass the returned dispatcher to `fetch(url, { dispatcher })` for requests
 * that need to go through the static IP.
 */
export function getProxyDispatcher(): Dispatcher | undefined {
  const proxyUrl = process.env.FIXIE_URL;
  if (!proxyUrl) return undefined;

  if (cachedDispatcher) return cachedDispatcher;

  const proxy = parseFixieUrl(proxyUrl);

  cachedDispatcher = new Agent({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    connect: async (opts: any, callback: any) => {
      try {
        // 1) Open raw TCP tunnel through SOCKS5 to the destination host:port
        const { socket } = await SocksClient.createConnection({
          proxy: {
            host: proxy.host,
            port: proxy.port,
            type: 5,
            userId: proxy.username,
            password: proxy.password,
          },
          command: 'connect',
          destination: {
            host: opts.hostname,
            port: Number(opts.port) || (opts.protocol === 'https:' ? 443 : 80),
          },
          timeout: 15_000,
        });

        // 2) For HTTPS, layer TLS on top of the SOCKS tunnel. undici passes
        //    ALPN/servername options via opts — preserve them so HTTP/2 can
        //    negotiate if the server supports it.
        if (opts.protocol === 'https:') {
          const tlsSocket = tls.connect({
            socket,
            servername: opts.servername ?? opts.hostname,
            ALPNProtocols: opts.ALPNProtocols ?? ['h2', 'http/1.1'],
            rejectUnauthorized: opts.rejectUnauthorized ?? true,
          });
          tlsSocket.once('secureConnect', () => callback(null, tlsSocket));
          tlsSocket.once('error', (err: Error) => callback(err, null));
        } else {
          callback(null, socket);
        }
      } catch (err) {
        callback(err as Error, null);
      }
    },
  });

  return cachedDispatcher;
}

/**
 * Convenience wrapper: returns a fetch-compatible init object that includes
 * the proxy dispatcher when available. Merges with existing init options.
 */
export function withProxy(init?: RequestInit): RequestInit & { dispatcher?: Dispatcher } {
  const dispatcher = getProxyDispatcher();
  if (!dispatcher) return init ?? {};
  return { ...init, dispatcher };
}

/**
 * Returns true when the proxy is configured (FIXIE_URL env var is set).
 */
export function isProxyEnabled(): boolean {
  return !!process.env.FIXIE_URL;
}
