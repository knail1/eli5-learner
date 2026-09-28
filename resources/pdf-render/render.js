/* global window, OffscreenCanvas */
// pdf-render page (04 §6.3): renders scanned PDF pages to PNG with pdf.js on an OffscreenCanvas,
// and normalizes images for vision (04 §7.1). Speaks { op, id, ... } over the MessagePort that the
// preload forwards; bytes are structured-cloned.
import * as pdfjs from 'eli5res://pdfjs/pdf.mjs';
import { normalizeImage } from './normalize.js';

pdfjs.GlobalWorkerOptions.workerSrc = 'eli5res://pdfjs/pdf.worker.mjs';

// Documents opened once per source (open-pdf), rendered page by page (render-page), then closed.
const docs = new Map();
let nextDocId = 1;

async function openPdf(msg) {
  const task = pdfjs.getDocument({
    data: msg.pdf,
    isEvalSupported: false,
    disableAutoFetch: true,
    disableStream: true,
    useSystemFonts: false,
  });
  try {
    const doc = await task.promise;
    const docId = nextDocId++;
    docs.set(docId, doc);
    return { docId };
  } catch (e) {
    await task.destroy().catch(() => undefined);
    return { error: e && e.name ? e.name : 'open failed' };
  }
}

async function renderPage(msg) {
  const doc = docs.get(msg.docId);
  if (!doc) return { page: msg.page, error: 'no document' };
  try {
    const page = await doc.getPage(msg.page);
    const base = page.getViewport({ scale: 1 });
    const scale = msg.targetLongEdgePx / Math.max(base.width, base.height);
    const viewport = page.getViewport({ scale });
    const canvas = new OffscreenCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas: null, canvasContext: ctx, viewport }).promise;
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    page.cleanup();
    return {
      page: msg.page,
      png: new Uint8Array(await blob.arrayBuffer()),
      width: canvas.width,
      height: canvas.height,
    };
  } catch (e) {
    return { page: msg.page, error: e && e.name ? e.name : 'render failed' };
  }
}

async function closePdf(msg) {
  const doc = docs.get(msg.docId);
  docs.delete(msg.docId);
  if (doc) await doc.destroy().catch(() => undefined);
}

async function handle(port, msg) {
  if (!msg || typeof msg.id !== 'number') return;
  try {
    if (msg.op === 'open-pdf') {
      port.postMessage({ id: msg.id, ...(await openPdf(msg)) });
    } else if (msg.op === 'render-page') {
      port.postMessage({ id: msg.id, ...(await renderPage(msg)) });
    } else if (msg.op === 'close-pdf') {
      await closePdf(msg);
    } else if (msg.op === 'normalize-image') {
      port.postMessage({ id: msg.id, ...(await normalizeImage(msg.bytes, msg.mediaType, msg.opts)) });
    } else {
      port.postMessage({ id: msg.id, ok: false, code: 'corrupt' });
    }
  } catch {
    port.postMessage({ id: msg.id, ok: false, code: 'corrupt', error: 'failed' });
  }
}

let connected = false;
window.addEventListener('message', (e) => {
  if (connected || e.source !== window || e.data !== 'eli5-render-port' || !e.ports || !e.ports[0]) return;
  connected = true;
  const port = e.ports[0];
  // One request at a time (04 §6.3 step 5): pages never render side by side. Main destroys the
  // window when a request times out, so a stuck render cannot hold the queue past its budget.
  let chain = Promise.resolve();
  port.onmessage = (ev) => {
    chain = chain.then(() => handle(port, ev.data));
  };
});
