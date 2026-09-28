/**
 * Local HTTP server for fetch tests (13 §6.4). Serves test/fixtures/sites/ on 127.0.0.1:<random>
 * and registers its port with net-guard. Scripted behaviors:
 *   /redirect-loop/   302 forever (to /redirect-loop/?hop=n+1)
 *   /slow/            sends the first bytes, then stalls for `slowMs` (default 20 s)
 *   /binary/deck.pptx a synthetic zip body with the PPTX content type
 * Tests add more with `route(path, handler)`. Every request is recorded in `hits`.
 */
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { allowLocalPort } from './net-guard';

export const SITES_DIR = path.resolve(import.meta.dirname, '../fixtures/sites');

export interface Hit {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
}

export type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => unknown;

export interface FixtureServer {
  origin: string; // http://127.0.0.1:<port>
  port: number;
  url(p: string): string;
  hits: Hit[];
  route(p: string, h: Handler): void;
  close(): Promise<void>;
}

export interface FixtureServerOptions {
  slowMs?: number;
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.txt': 'text/plain; charset=utf-8',
};

/** A zip local-file-header prefix plus filler: enough for magic-byte sniffing, not a real deck. */
export function syntheticZip(size = 2048): Buffer {
  const b = Buffer.alloc(size, 0x20);
  b.set([0x50, 0x4b, 0x03, 0x04], 0);
  return b;
}

export async function startFixtureServer(opts: FixtureServerOptions = {}): Promise<FixtureServer> {
  const routes = new Map<string, Handler>();
  const hits: Hit[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const slowMs = opts.slowMs ?? 20_000;

  routes.set('/redirect-loop/', (req, res) => {
    const n = Number(new URL(req.url ?? '/', 'http://x').searchParams.get('hop') ?? '0');
    res.writeHead(302, { Location: `/redirect-loop/?hop=${n + 1}` }).end();
  });
  routes.set('/slow/', (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.write('<!doctype html><html><head><title>Slow page</title></head><body><p>');
    const t = setTimeout(() => {
      timers.delete(t);
      res.end('done</p></body></html>');
    }, slowMs);
    timers.add(t);
  });
  routes.set('/binary/deck.pptx', (_req, res) => {
    res
      .writeHead(200, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.presentationml.presentation' })
      .end(syntheticZip());
  });

  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1');
    hits.push({ method: req.method ?? 'GET', path: u.pathname + u.search, headers: req.headers });
    const handler = routes.get(u.pathname);
    const run = handler ? Promise.resolve(handler(req, res)) : serveStatic(u.pathname, res);
    run.catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  allowLocalPort(port);
  const origin = `http://127.0.0.1:${port}`;

  return {
    origin,
    port,
    url: (p) => origin + p,
    hits,
    route: (p, h) => routes.set(p, h),
    close: async () => {
      for (const t of timers) clearTimeout(t);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function serveStatic(pathname: string, res: http.ServerResponse): Promise<void> {
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.resolve(SITES_DIR, '.' + rel);
  if (!file.startsWith(SITES_DIR + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream' }).end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/html' }).end('<!doctype html><title>Not found</title><p>Not found</p>');
  }
}
