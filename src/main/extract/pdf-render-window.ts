/**
 * The hidden pdf-render window (04 §6.3, §7.1; 01 §2 "pdf-render window"): one sandboxed, hidden
 * BrowserWindow per job that renders scanned PDF pages with pdf.js and normalizes images with
 * Chromium's decoders, so no image work runs on the main event loop. The page loads over eli5res://
 * (module workers are refused from file://), has no network, and talks to main over a
 * MessagePort that the minimal preload forwards. Electron is injected so this file has no runtime
 * electron import and the rest of the module stays testable in Node.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type * as Electron from 'electron';
import { DEFAULT_EXTRACT_LIMITS, EXTRACT_TIMEOUTS_MS } from './limits';
import type { ExtractLimits, ImageAsset, ImageNormalizer, PdfPageRenderer } from './types';

export const PDF_RENDER_SCHEME = 'eli5res';
export const PDF_RENDER_PARTITION = 'eli5-pdf-render';
export const PDF_RENDER_PAGE_URL = `${PDF_RENDER_SCHEME}://pdf-render/render.html`;
export const PDF_RENDER_PORT_CHANNEL = 'eli5:extract:render-port';

/** Pass to protocol.registerSchemesAsPrivileged before app ready (04 §6.3 step 1). */
export const PDF_RENDER_SCHEME_PRIVILEGES: Electron.CustomScheme = {
  scheme: PDF_RENDER_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true },
};

export interface RenderRoots {
  /** resources/pdf-render (render.html, render.js, normalize.js, preload.cjs). */
  pdfRender: string;
  /** Directory holding pdf.mjs and pdf.worker.mjs. */
  pdfjs: string;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
};

/**
 * Maps eli5res://pdf-render/<file> and eli5res://pdfjs/<file> to files under the two roots.
 * Anything else, or any path escaping its root, is refused (null).
 */
export function resolveRenderResource(url: string, roots: RenderRoots): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== `${PDF_RENDER_SCHEME}:`) return null;
  const root = u.hostname === 'pdf-render' ? roots.pdfRender : u.hostname === 'pdfjs' ? roots.pdfjs : undefined;
  if (!root) return null;
  const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
  if (!rel || rel.includes('\0')) return null;
  const abs = path.resolve(root, rel);
  const base = path.resolve(root) + path.sep;
  if (!abs.startsWith(base)) return null;
  if (!MIME[path.extname(abs)]) return null;
  return abs;
}

/** Only these schemes may load in the render window (04 §6.3 step 2). */
export function isAllowedRenderRequest(url: string): boolean {
  return url.startsWith(`${PDF_RENDER_SCHEME}:`) || url.startsWith('blob:') || url.startsWith('data:');
}

export type ElectronForRender = Pick<typeof Electron, 'BrowserWindow' | 'MessageChannelMain' | 'session'>;

export interface PdfRenderWindowOptions {
  electron: ElectronForRender;
  roots: RenderRoots;
  /** Absolute path to resources/pdf-render/preload.cjs. */
  preloadPath: string;
  limits?: ExtractLimits;
  /** Security hook (12 §7): e.g. registerSurface(wc, 'other', u => u.protocol === 'eli5res:'). */
  prepareWebContents?: (wc: Electron.WebContents) => void;
  log?: (msg: string) => void;
}

type Reply = { id: number } & Record<string, unknown>;

interface Pending {
  resolve: (r: Reply) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const handledSessions = new WeakSet<object>();

/** One instance per job; destroy() at job end. */
export class PdfRenderWindow {
  private win: Electron.BrowserWindow | undefined;
  private port: Electron.MessagePortMain | undefined;
  private ready: Promise<void> | undefined;
  private recreated = false;
  private seq = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly limits: ExtractLimits;

  constructor(private readonly opts: PdfRenderWindowOptions) {
    this.limits = opts.limits ?? DEFAULT_EXTRACT_LIMITS;
  }

  private setupSession(): Electron.Session {
    const ses = this.opts.electron.session.fromPartition(PDF_RENDER_PARTITION);
    if (!handledSessions.has(ses)) {
      handledSessions.add(ses);
      ses.protocol.handle(PDF_RENDER_SCHEME, async (req) => {
        const file = resolveRenderResource(req.url, this.opts.roots);
        if (!file) return new Response('not found', { status: 404 });
        try {
          const body = await readFile(file);
          return new Response(body, { headers: { 'content-type': MIME[path.extname(file)] ?? 'text/plain' } });
        } catch {
          return new Response('not found', { status: 404 });
        }
      });
      ses.webRequest.onBeforeRequest((details, cb) => cb({ cancel: !isAllowedRenderRequest(details.url) }));
      ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    }
    return ses;
  }

  private start(): Promise<void> {
    if (this.ready) return this.ready;
    this.setupSession();
    const { BrowserWindow, MessageChannelMain } = this.opts.electron;
    const win = new BrowserWindow({
      show: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        webviewTag: false,
        spellcheck: false,
        backgroundThrottling: false, // a hidden window is otherwise throttled (04 §6.3 step 2)
        preload: this.opts.preloadPath,
        partition: PDF_RENDER_PARTITION,
      },
    });
    this.win = win;
    this.opts.prepareWebContents?.(win.webContents);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.webContents.on('render-process-gone', () => {
      this.opts.log?.('pdf-render: renderer gone');
      this.failAll(new Error('render window crashed'));
      this.teardown();
    });
    this.ready = (async () => {
      await win.loadURL(PDF_RENDER_PAGE_URL);
      const { port1, port2 } = new MessageChannelMain();
      port1.on('message', (e) => this.onReply(e.data as Reply));
      port1.start();
      this.port = port1;
      win.webContents.postMessage(PDF_RENDER_PORT_CHANNEL, null, [port2]);
    })();
    return this.ready;
  }

  private teardown(): void {
    const w = this.win;
    this.win = undefined;
    this.port?.close();
    this.port = undefined;
    this.ready = undefined;
    if (w && !w.isDestroyed()) w.destroy();
  }

  private failAll(err: Error): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(id);
    }
  }

  private onReply(r: Reply): void {
    const p = this.pending.get(r.id);
    if (!p) return;
    this.pending.delete(r.id);
    clearTimeout(p.timer);
    p.resolve(r);
  }

  private async request(msg: Record<string, unknown>, timeoutMs: number, signal: AbortSignal): Promise<Reply> {
    if (!this.ready && this.win === undefined && this.seq > 0) {
      // The renderer died earlier in this job: recreate once (04 §6.3 step 5).
      if (this.recreated) throw new Error('render window unavailable');
      this.recreated = true;
    }
    await this.start();
    const port = this.port;
    if (!port) throw new Error('render window unavailable');
    const id = ++this.seq;
    return new Promise<Reply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('timeout'));
      }, timeoutMs);
      const onAbort = (): void => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error('aborted'));
      };
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, {
        resolve: (r) => {
          signal.removeEventListener('abort', onAbort);
          resolve(r);
        },
        reject,
        timer,
      });
      port.postMessage({ ...msg, id });
    });
  }

  /** PdfPageRenderer: pages render one at a time, each with its own timeout (04 §6.3 step 5). */
  readonly renderPdfPages: PdfPageRenderer = async (pdf, pages, opts) => {
    const out: Awaited<ReturnType<PdfPageRenderer>> = [];
    for (const page of pages) {
      if (opts.signal.aborted) {
        out.push({ page, error: 'aborted' });
        continue;
      }
      try {
        const r = await this.request(
          { op: 'render-pdf', pdf, pages: [page], targetLongEdgePx: opts.targetLongEdgePx },
          this.limits.pdf.renderPageTimeoutMs,
          opts.signal,
        );
        const first = (r.results as unknown[] | undefined)?.[0] as
          { page: number; png?: Uint8Array; width?: number; height?: number; error?: string } | undefined;
        if (first?.png && first.width && first.height) {
          out.push({ page, png: new Uint8Array(first.png), width: first.width, height: first.height });
        } else {
          out.push({ page, error: first?.error ?? 'render failed' });
        }
      } catch (e) {
        out.push({ page, error: e instanceof Error ? e.message : 'render failed' });
      }
    }
    return out;
  };

  /** ImageNormalizer backed by resources/pdf-render/normalize.js (04 §7.1 steps 2-7). */
  readonly normalizeImage: ImageNormalizer = async (bytes, mediaType, opts) => {
    const im = this.limits.images;
    try {
      const r = await this.request(
        {
          op: 'normalize-image',
          bytes,
          mediaType,
          opts: {
            targetLongEdgePx: im.targetLongEdgePx,
            maxOutputBytes: im.maxOutputBytes,
            maxAspect: im.maxAspect,
            maxTiles: 6,
          },
        },
        EXTRACT_TIMEOUTS_MS.image,
        opts.signal,
      );
      if (r.ok !== true) return { ok: false, code: r.code === 'image-too-large' ? 'image-too-large' : 'corrupt' };
      const assets = (r.assets as Array<Omit<ImageAsset, 'id' | 'origin' | 'byteLength'>>).map((a, i) => ({
        id: `norm-${i + 1}`,
        mediaType: a.mediaType,
        data: new Uint8Array(a.data),
        width: a.width,
        height: a.height,
        byteLength: a.data.byteLength,
        ...(a.distinctColors !== undefined ? { distinctColors: a.distinctColors } : {}),
        origin: opts.origin,
      }));
      return { ok: true, assets };
    } catch {
      return { ok: false, code: 'corrupt' };
    }
  };

  destroy(): void {
    this.failAll(new Error('destroyed'));
    this.teardown();
  }
}
