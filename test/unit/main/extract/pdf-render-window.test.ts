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
function fakeElectron(
  page: (msg: Record<string, unknown>) => Record<string, unknown> | undefined,
  o: { failLoads?: number } = {},
) {
  const created: Array<{ opts: Record<string, unknown> }> = [];
  let destroyed = 0;
  let failLoads = o.failLoads ?? 0;
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
    private gone = false;
    loadURL(): Promise<void> {
      if (failLoads > 0) {
        failLoads--;
        return Promise.reject(new Error('ERR_ABORTED'));
      }
      return Promise.resolve();
    }
    isDestroyed(): boolean {
      return this.gone;
    }
    destroy(): void {
      this.gone = true;
      destroyed++;
    }
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
  return { electron, created, beforeRequest: () => beforeRequest, destroyed: () => destroyed };
}

describe('PdfRenderWindow', () => {
  it('creates a hidden, sandboxed, unthrottled window and renders pages one at a time', async () => {
    const seen: unknown[] = [];
    const fx = fakeElectron((msg) => {
      seen.push(msg.op === 'render-page' ? msg.page : msg.op);
      if (msg.op === 'open-pdf') return { id: msg.id, docId: 7 };
      if (msg.op === 'render-page') {
        expect(msg.docId).toBe(7);
        return { id: msg.id, page: msg.page, png: new Uint8Array([1]), width: 10, height: 20 };
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
    // The document is sent and parsed once per source, then closed.
    expect(seen).toEqual(['open-pdf', 1, 2, 'close-pdf']);
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
        : msg.op === 'open-pdf'
          ? { id: msg.id, docId: 1 }
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

  it('tears the window down after a page timeout so the next page never renders beside it', async () => {
    let opens = 0;
    const fx = fakeElectron((msg) => {
      if (msg.op === 'open-pdf') return { id: msg.id, docId: ++opens };
      if (msg.op === 'render-page' && msg.page === 2)
        return { id: msg.id, png: new Uint8Array([2]), width: 1, height: 1 };
      return undefined; // page 1 hangs
    });
    const limits = {
      ...(await import('../../../../src/main/extract')).DEFAULT_EXTRACT_LIMITS,
      pdf: { maxPages: 500, minCharsPerPage: 40, maxRenderedPages: 30, renderPageTimeoutMs: 20 },
    };
    const w = new PdfRenderWindow({ electron: fx.electron, roots, preloadPath: '/p.cjs', limits });
    const out = await w.renderPdfPages(new Uint8Array(1), [1, 2], {
      targetLongEdgePx: 1568,
      signal: new AbortController().signal,
    });
    expect(out).toEqual([
      { page: 1, error: 'timeout' },
      { page: 2, png: new Uint8Array([2]), width: 1, height: 1 },
    ]);
    expect(fx.destroyed()).toBe(1);
    expect(fx.created).toHaveLength(2);
    expect(opens).toBe(2);
    w.destroy();
  });

  it('does not cache a failed page load: the window is recreated once', async () => {
    const fx = fakeElectron(
      (msg) =>
        msg.op === 'normalize-image'
          ? { id: msg.id, ok: true, assets: [{ mediaType: 'image/png', data: new Uint8Array(2), width: 1, height: 1 }] }
          : undefined,
      { failLoads: 1 },
    );
    const w = new PdfRenderWindow({ electron: fx.electron, roots, preloadPath: '/p.cjs' });
    const opts = { origin: 'standalone' as const, signal: new AbortController().signal };
    expect(await w.normalizeImage(new Uint8Array(1), 'image/png', opts)).toEqual({ ok: false, code: 'corrupt' });
    expect(fx.destroyed()).toBe(1);
    expect(await w.normalizeImage(new Uint8Array(1), 'image/png', opts)).toMatchObject({ ok: true });
    expect(fx.created).toHaveLength(2);
    w.destroy();
  });
});
