/** pdf-render window (04 §6.3) against a fake Electron: scheme mapping, network block, port protocol. */
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import {
  PDF_RENDER_PARTITION,
  PDF_RENDER_SCHEME_PRIVILEGES,
  PdfRenderWindow,
  resolveRenderResource,
  type PdfRenderWindowOptions,
} from '../../../../src/main/extract';
import { isAllowedRenderRequest } from '../../../../src/main/extract/pdf-render-window';

const roots = { pdfRender: '/app/resources/pdf-render', pdfjs: '/app/node_modules/pdfjs-dist/build' };

describe('render resources over eli5res://', () => {
  it('maps only files under the two roots', () => {
    expect(resolveRenderResource('eli5res://pdf-render/render.html', roots)).toBe(
      '/app/resources/pdf-render/render.html',
    );
    expect(resolveRenderResource('eli5res://pdfjs/pdf.worker.mjs', roots)).toBe(
      '/app/node_modules/pdfjs-dist/build/pdf.worker.mjs',
    );
    // The URL parser normalizes dot segments, so this stays inside the root.
    expect(resolveRenderResource('eli5res://pdf-render/../../secret.js', roots)).toBe(
      '/app/resources/pdf-render/secret.js',
    );
    expect(resolveRenderResource('eli5res://pdf-render/..%2f..%2fsecret.js', roots)).toBeNull();
    expect(resolveRenderResource('eli5res://other/render.html', roots)).toBeNull();
    expect(resolveRenderResource('file:///app/resources/pdf-render/render.html', roots)).toBeNull();
    expect(resolveRenderResource('eli5res://pdf-render/data.bin', roots)).toBeNull();
  });

  it('blocks every request outside eli5res:, blob: and data:', () => {
    expect(isAllowedRenderRequest('eli5res://pdfjs/pdf.mjs')).toBe(true);
    expect(isAllowedRenderRequest('blob:eli5res://x/1')).toBe(true);
    expect(isAllowedRenderRequest('https://example.com/x.js')).toBe(false);
    expect(isAllowedRenderRequest('file:///etc/hosts')).toBe(false);
    expect(PDF_RENDER_SCHEME_PRIVILEGES).toEqual({
      scheme: 'eli5res',
      privileges: { standard: true, secure: true, supportFetchAPI: true },
    });
  });
});

/** Fake Electron pieces: the "page" answers requests posted on port1. */
function fakeElectron(page: (msg: Record<string, unknown>) => Record<string, unknown> | undefined) {
  const created: Array<{ opts: Record<string, unknown> }> = [];
  let beforeRequest: ((d: { url: string }, cb: (r: { cancel: boolean }) => void) => void) | undefined;
  const ses = {
    protocol: { handle: () => undefined },
    webRequest: { onBeforeRequest: (fn: typeof beforeRequest) => (beforeRequest = fn) },
    setPermissionRequestHandler: () => undefined,
  };
  class Port extends EventEmitter {
    peer?: Port;
    start(): void {}
    close(): void {}
    postMessage(data: unknown): void {
      const reply = page(data as Record<string, unknown>);
      if (reply) setTimeout(() => this.emit('message', { data: reply }), 0);
    }
  }
  class BrowserWindow {
    webContents = Object.assign(new EventEmitter(), {
      setWindowOpenHandler: () => undefined,
      postMessage: () => undefined,
    });
    constructor(opts: Record<string, unknown>) {
      created.push({ opts });
    }
    loadURL(): Promise<void> {
      return Promise.resolve();
    }
    isDestroyed(): boolean {
      return false;
    }
    destroy(): void {}
  }
  class MessageChannelMain {
    port1 = new Port();
    port2 = new Port();
  }
  const electron = {
    BrowserWindow,
    MessageChannelMain,
    session: { fromPartition: (p: string) => (p === PDF_RENDER_PARTITION ? ses : undefined) },
  } as unknown as PdfRenderWindowOptions['electron'];
  return { electron, created, beforeRequest: () => beforeRequest };
}

describe('PdfRenderWindow', () => {
  it('creates a hidden, sandboxed, unthrottled window and renders pages one at a time', async () => {
    const seen: number[][] = [];
    const fx = fakeElectron((msg) => {
      if (msg.op === 'render-pdf') {
        const pages = msg.pages as number[];
        seen.push(pages);
        return { id: msg.id, results: [{ page: pages[0], png: new Uint8Array([1]), width: 10, height: 20 }] };
      }
      return undefined;
    });
    const w = new PdfRenderWindow({
      electron: fx.electron,
      roots,
      preloadPath: '/app/resources/pdf-render/preload.cjs',
    });
    const out = await w.renderPdfPages(new Uint8Array([37]), [1, 2], {
      targetLongEdgePx: 1568,
      signal: new AbortController().signal,
    });
    expect(seen).toEqual([[1], [2]]);
    expect(out).toEqual([
      { page: 1, png: new Uint8Array([1]), width: 10, height: 20 },
      { page: 2, png: new Uint8Array([1]), width: 10, height: 20 },
    ]);
    expect(fx.created).toHaveLength(1);
    expect(fx.created[0]!.opts).toMatchObject({
      show: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        partition: PDF_RENDER_PARTITION,
      },
    });
    let cancelled: boolean | undefined;
    fx.beforeRequest()?.({ url: 'https://example.com/' }, (r) => (cancelled = r.cancel));
    expect(cancelled).toBe(true);
    w.destroy();
  });

  it('returns a per-page error when a page times out, and maps normalize replies', async () => {
    const fx = fakeElectron((msg) =>
      msg.op === 'normalize-image'
        ? {
            id: msg.id,
            ok: true,
            assets: [{ mediaType: 'image/png', data: new Uint8Array(4), width: 2, height: 2, distinctColors: 3 }],
          }
        : undefined,
    );
    const limits = {
      ...(await import('../../../../src/main/extract')).DEFAULT_EXTRACT_LIMITS,
      pdf: { maxPages: 500, minCharsPerPage: 40, maxRenderedPages: 30, renderPageTimeoutMs: 20 },
    };
    const w = new PdfRenderWindow({ electron: fx.electron, roots, preloadPath: '/p.cjs', limits });
    const out = await w.renderPdfPages(new Uint8Array(1), [4], {
      targetLongEdgePx: 1568,
      signal: new AbortController().signal,
    });
    expect(out).toEqual([{ page: 4, error: 'timeout' }]);
    const n = await w.normalizeImage(new Uint8Array(3), 'image/png', {
      origin: 'standalone',
      signal: new AbortController().signal,
    });
    expect(n).toMatchObject({
      ok: true,
      assets: [{ mediaType: 'image/png', width: 2, height: 2, byteLength: 4, origin: 'standalone' }],
    });
    w.destroy();
  });
});
