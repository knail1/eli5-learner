// "Hide highlights" for woven-merge enhancements (07 §6.4, §14). Highlights show without JS; the
// choice is remembered per document in localStorage when available.

export const ENH_KEY_PREFIX = 'eli5.enh.';

function read(win: Window, key: string): boolean {
  try {
    return win.localStorage.getItem(key) === 'hidden';
  } catch {
    return false; // storage blocked (file:// in some browsers): highlights stay on
  }
}

function write(win: Window, key: string, hidden: boolean): void {
  try {
    if (hidden) win.localStorage.setItem(key, 'hidden');
    else win.localStorage.removeItem(key);
  } catch {
    // per-viewer convenience only
  }
}

export function initEnhancements(doc: Document, win: Window): void {
  const legend = doc.querySelector<HTMLElement>('.enh-legend');
  const btn = legend?.querySelector<HTMLButtonElement>('.enh-toggle');
  if (!legend || !btn) return;
  const key = ENH_KEY_PREFIX + (legend.getAttribute('data-doc-id') ?? '');
  const apply = (hidden: boolean): void => {
    if (hidden) doc.documentElement.setAttribute('data-hide-enh', '');
    else doc.documentElement.removeAttribute('data-hide-enh');
    btn.textContent = hidden ? 'Show highlights' : 'Hide highlights';
    btn.setAttribute('aria-pressed', hidden ? 'true' : 'false');
  };
  let hidden = read(win, key);
  apply(hidden);
  btn.hidden = false;
  btn.addEventListener('click', () => {
    hidden = !hidden;
    apply(hidden);
    write(win, key, hidden);
  });
}
