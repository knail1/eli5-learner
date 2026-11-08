// Animation frames (07 §7.1, §14): the parent side of the sandboxed srcdoc frames. Sends each frame
// the effective theme ('light' | 'dark') when it loads and whenever it changes, and accepts exactly
// one message shape back, `{type:'eli5-anim-height', h:number}` from one of its own frames, which
// sets that frame's height (clamped) and reveals it over the poster. Nothing else is read from a
// frame and nothing else is sent to one.

/** Height clamp for a frame's reported content height, in CSS pixels. */
export const MIN_FRAME_HEIGHT = 120;
export const MAX_FRAME_HEIGHT = 800;

export type FrameTheme = 'light' | 'dark';

/** The theme a frame should draw in: the document's explicit choice, else the system's. */
export function effectiveTheme(doc: Document, win: Window): FrameTheme {
  const pref = doc.documentElement.getAttribute('data-theme');
  if (pref === 'light' || pref === 'dark') return pref;
  try {
    return win.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

/** The height from a frame message, or undefined unless it is exactly the allowed shape. */
export function frameHeight(data: unknown): number | undefined {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined;
  const keys = Object.keys(data);
  const d = data as { type?: unknown; h?: unknown };
  if (keys.length !== 2 || d.type !== 'eli5-anim-height' || typeof d.h !== 'number' || !Number.isFinite(d.h))
    return undefined;
  return Math.min(MAX_FRAME_HEIGHT, Math.max(MIN_FRAME_HEIGHT, Math.round(d.h)));
}

export function initAnimations(doc: Document, win: Window): void {
  const frames = Array.from(doc.querySelectorAll<HTMLIFrameElement>('figure.animation .anim-stage > iframe'));
  if (frames.length === 0) return;
  const send = (f: HTMLIFrameElement): void => {
    try {
      // A sandboxed srcdoc frame has an opaque origin, so '*' is the only possible target; the
      // message carries nothing but the theme name.
      f.contentWindow?.postMessage({ type: 'eli5-anim-theme', theme: effectiveTheme(doc, win) }, '*');
    } catch {
      // a frame that is gone or not loaded yet gets the theme on its load event
    }
  };
  const sendAll = (): void => frames.forEach(send);
  for (const f of frames) {
    f.addEventListener('load', () => send(f));
    send(f);
  }
  win.addEventListener('message', (e: MessageEvent) => {
    const f = frames.find((x) => x.contentWindow !== null && x.contentWindow === e.source);
    if (!f) return;
    const h = frameHeight(e.data);
    if (h === undefined) return;
    const stage = f.parentElement;
    const fig = stage?.parentElement;
    if (!stage || !fig) return;
    const px = `${h}px`;
    if (stage.style.height !== px) stage.style.height = px;
    fig.classList.add('anim-live');
  });
  try {
    new MutationObserver(sendAll).observe(doc.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  } catch {
    // no MutationObserver: frames keep the theme they loaded with
  }
  try {
    win.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', sendAll);
  } catch {
    // older engines: same as above
  }
}
