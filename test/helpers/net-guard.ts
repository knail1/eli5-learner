/**
 * Fails any test that opens a socket to anything but 127.0.0.1 on a port registered by
 * fixture-server.ts (13 §3.2). Suites that must reach the network opt out with ELI5_ALLOW_NET=1.
 */
import net from 'node:net';

export class NetworkAccessInTest extends Error {
  constructor(target: string) {
    super(`Network access in test: ${target}`);
    this.name = 'NetworkAccessInTest';
  }
}

const allowedPorts = new Set<number>();
/** Called by fixture-server.ts when it starts listening. */
export function allowLocalPort(port: number): void {
  allowedPorts.add(port);
}

function isAllowed(host: string | undefined, port: number | undefined): boolean {
  const h = host ?? 'localhost';
  return (h === '127.0.0.1' || h === 'localhost' || h === '::1') && port !== undefined && allowedPorts.has(port);
}

if (process.env.ELI5_ALLOW_NET !== '1') {
  const origConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
    const first = args[0];
    let host: string | undefined;
    let port: number | undefined;
    if (typeof first === 'object' && first !== null) {
      const o = first as { host?: string; port?: number; path?: string };
      if (o.path) return (origConnect as (...a: unknown[]) => net.Socket).apply(this, args); // IPC sockets
      host = o.host;
      port = o.port;
    } else if (typeof first === 'number') {
      port = first;
      host = typeof args[1] === 'string' ? args[1] : undefined;
    } else if (typeof first === 'string') {
      return (origConnect as (...a: unknown[]) => net.Socket).apply(this, args); // unix socket path
    }
    if (!isAllowed(host, port)) throw new NetworkAccessInTest(`${host ?? 'localhost'}:${port ?? '?'}`);
    return (origConnect as (...a: unknown[]) => net.Socket).apply(this, args);
  } as typeof net.Socket.prototype.connect;

  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const port = url.port ? Number(url.port) : undefined;
    if (!isAllowed(url.hostname, port)) throw new NetworkAccessInTest(url.origin);
    return origFetch(input, init);
  }) as typeof fetch;
}
