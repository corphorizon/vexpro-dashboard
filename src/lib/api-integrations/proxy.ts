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

import { Agent, fetch as undiciFetch, type Dispatcher } from 'undici';
import { SocksClient } from 'socks';
import tls from 'node:tls';
import dnsPromises from 'node:dns/promises';

// UniPayment's API sits behind Cloudflare which blocks IPv6 connections from
// certain proxy ranges (including Fixie). Resolve hostnames to IPv4 ourselves
// before passing them to the SOCKS5 proxy so the outbound connection is
// guaranteed to be IPv4.
async function resolveIPv4(hostname: string): Promise<string> {
  // If already an IP, return as-is
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) return hostname;
  try {
    const res = await dnsPromises.lookup(hostname, { family: 4 });
    return res.address;
  } catch {
    // Fallback to the original hostname — SOCKS5 will try to resolve it
    return hostname;
  }
}

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
        // Force IPv4 resolution — Cloudflare-fronted APIs (e.g. UniPayment)
        // reject IPv6 connections from proxy ranges.
        const ipv4Host = await resolveIPv4(opts.hostname);

        // 1) Open raw TCP tunnel through SOCKS5 to the destination IPv4:port
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
            host: ipv4Host,
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
 * Drop-in fetch replacement that routes through the proxy when FIXIE_URL is
 * set, falling back to the platform's native fetch otherwise.
 *
 * Uses `undici.fetch` (not native global fetch) to guarantee the dispatcher
 * option is respected — Vercel's serverless runtime wraps native fetch and
 * may silently drop the dispatcher, bypassing the proxy.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function proxiedFetch(url: string | URL, init?: any): Promise<Response> {
  const dispatcher = getProxyDispatcher();
  if (!dispatcher) {
    return fetch(url, init);
  }
  // Cast to Response to satisfy callers that use the standard fetch API.
  return undiciFetch(url, { ...init, dispatcher }) as unknown as Response;
}

/**
 * Returns true when the proxy is configured (FIXIE_URL env var is set).
 */
export function isProxyEnabled(): boolean {
  return !!process.env.FIXIE_URL;
}
