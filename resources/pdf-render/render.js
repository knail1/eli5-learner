/* global window, OffscreenCanvas */
// pdf-render page (04 §6.3): renders scanned PDF pages to PNG with pdf.js on an OffscreenCanvas,
// and normalizes images for vision (04 §7.1). Speaks { op, id, ... } over the MessagePort that the
// preload forwards; bytes are structured-cloned.
import * as pdfjs from 'eli5res://pdfjs/pdf.mjs';
import { normalizeImage } from './normalize.js';

pdfjs.GlobalWorkerOptions.workerSrc = 'eli5res://pdfjs/pdf.worker.mjs';

async function renderPdf(msg) {
  const task = pdfjs.getDocument({
    data: msg.pdf,
    isEvalSupported: false,
    disableAutoFetch: true,
    disableStream: true,
    useSystemFonts: false,
  });
  const doc = await task.promise;
  const results = [];
  try {
    for (const n of msg.pages) {
      try {
        const page = await doc.getPage(n);
        const base = page.getViewport({ scale: 1 });
        const scale = msg.targetLongEdgePx / Math.max(base.width, base.height);
        const viewport = page.getViewport({ scale });
        const canvas = new OffscreenCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvas: null, canvasContext: ctx, viewport }).promise;
        const blob = await canvas.convertToBlob({ type: 'image/png' });
        results.push({
          page: n,
          png: new Uint8Array(await blob.arrayBuffer()),
          width: canvas.width,
          height: canvas.height,
        });
        page.cleanup();
      } catch (e) {
        results.push({ page: n, error: e && e.name ? e.name : 'render failed' });
      }
    }
  } finally {
    await doc.destroy();
  }
  return { results };
}

async function handle(port, msg) {
  if (!msg || typeof msg.id !== 'number') return;
  try {
    if (msg.op === 'render-pdf') {
      port.postMessage({ id: msg.id, ...(await renderPdf(msg)) });
    } else if (msg.op === 'normalize-image') {
      port.postMessage({ id: msg.id, ...(await normalizeImage(msg.bytes, msg.mediaType, msg.opts)) });
    } else {
      port.postMessage({ id: msg.id, ok: false, code: 'corrupt' });
    }
  } catch {
    port.postMessage({ id: msg.id, ok: false, code: 'corrupt', results: [] });
  }
}

let connected = false;
window.addEventListener('message', (e) => {
  if (connected || e.source !== window || e.data !== 'eli5-render-port' || !e.ports || !e.ports[0]) return;
  connected = true;
  const port = e.ports[0];
  port.onmessage = (ev) => {
    void handle(port, ev.data);
  };
});
