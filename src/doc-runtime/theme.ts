// Theme switching (07 §11.2): auto -> light -> dark, remembered in localStorage when available.

export const THEME_KEY = 'eli5.theme';
const ORDER = ['auto', 'light', 'dark'] as const;
type ThemePref = (typeof ORDER)[number];

function read(win: Window): ThemePref | undefined {
  try {
    const v = win.localStorage.getItem(THEME_KEY);
    return (ORDER as readonly string[]).includes(v ?? '') ? (v as ThemePref) : undefined;
  } catch {
    return undefined; // Safari over file:// may throw; fall back to in-memory state
  }
}

function write(win: Window, v: ThemePref): void {
  try {
    win.localStorage.setItem(THEME_KEY, v);
  } catch {
    // per-viewer convenience only
  }
}

/** Applies the stored preference; called first in boot (07 §14 step 1). */
export function applyStoredTheme(doc: Document, win: Window): ThemePref {
  const pref = read(win) ?? 'auto';
  doc.documentElement.setAttribute('data-theme', pref);
  return pref;
}

export function initThemeToggle(doc: Document, win: Window): void {
  const btn = doc.querySelector<HTMLButtonElement>('.theme-toggle');
  if (!btn) return;
  let pref = (doc.documentElement.getAttribute('data-theme') ?? 'auto') as ThemePref;
  const label = (): void => {
    btn.setAttribute('aria-label', `Switch theme (now ${pref})`);
  };
  btn.hidden = false;
  label();
  btn.addEventListener('click', () => {
    pref = ORDER[(ORDER.indexOf(pref) + 1) % ORDER.length] ?? 'auto';
    doc.documentElement.setAttribute('data-theme', pref);
    write(win, pref);
    label();
  });
}
