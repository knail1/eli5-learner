// Tab bar (07 §12): WAI-ARIA tabs, hash resolution, history-free activation for 08, and the
// --eli5-tabbar-h variable.

export interface TabsApi {
  keys(): string[];
  active(): string | undefined;
  /** Activates a tab; `history: false` leaves location.hash alone (07 §12 item 6). */
  activateTab(key: string, opts?: { history?: boolean; focus?: boolean }): boolean;
  /** Tab key holding a section, or undefined. */
  tabOfSection(sectionId: string): string | undefined;
  panel(key: string): HTMLElement | undefined;
  onChange(cb: (key: string) => void): void;
}

export function initTabs(doc: Document, win: Window): TabsApi {
  const bar = doc.querySelector<HTMLElement>('nav.tabbar');
  const buttons = Array.from(doc.querySelectorAll<HTMLButtonElement>('nav.tabbar [role="tab"]'));
  const panels = new Map<string, HTMLElement>();
  for (const p of Array.from(doc.querySelectorAll<HTMLElement>('.tabpanel[data-tab-key]'))) {
    panels.set(p.dataset.tabKey ?? '', p);
  }
  const keyOf = (b: HTMLButtonElement): string => (b.getAttribute('aria-controls') ?? '').replace(/^tab-/, '');
  const listeners: ((key: string) => void)[] = [];
  let current: string | undefined;

  const activateTab = (key: string, opts: { history?: boolean; focus?: boolean } = {}): boolean => {
    const panel = panels.get(key);
    if (!panel) return false;
    for (const b of buttons) {
      const on = keyOf(b) === key;
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
      if (on) {
        if (opts.focus) b.focus();
        b.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
      }
    }
    for (const [k, p] of panels) p.hidden = k !== key;
    const changed = current !== key;
    current = key;
    if (opts.history !== false) {
      try {
        win.history.replaceState(
          null,
          '',
          key === keys()[0] ? win.location.pathname + win.location.search : `#tab=${key}`,
        );
      } catch {
        // file:// in some engines: hash stays as is
      }
    }
    if (changed) for (const cb of listeners) cb(key);
    return true;
  };

  const keys = (): string[] => buttons.map(keyOf);
  const tabOfSection = (id: string): string | undefined => {
    const el = doc.getElementById(id);
    return el?.closest<HTMLElement>('.tabpanel[data-tab-key]')?.dataset.tabKey;
  };

  /** 07 §12 item 2: `#tab=<key>` selects a tab; `#sec-…` selects its tab and scrolls to it. */
  const resolveHash = (): void => {
    const raw = win.location.hash.replace(/^#/, '');
    let h = raw;
    try {
      h = decodeURIComponent(raw);
    } catch {
      // Malformed percent-escape (e.g. `#%`): use the raw hash, which falls back to the default tab.
    }
    if (h.startsWith('tab=') && activateTab(h.slice(4), { history: false })) return;
    if (h.startsWith('sec-')) {
      const k = tabOfSection(h);
      if (k && activateTab(k, { history: false })) {
        doc.getElementById(h)?.scrollIntoView?.({ block: 'start' });
        return;
      }
    }
    if (current === undefined) activateTab(keys()[0] ?? 'indepth', { history: false });
  };

  for (const b of buttons) {
    b.addEventListener('click', () => activateTab(keyOf(b)));
    b.addEventListener('keydown', (e) => {
      const ks = keys();
      const i = ks.indexOf(keyOf(b));
      let next: number | undefined;
      if (e.key === 'ArrowRight') next = (i + 1) % ks.length;
      else if (e.key === 'ArrowLeft') next = (i - 1 + ks.length) % ks.length;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = ks.length - 1;
      else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        activateTab(keyOf(b));
        return;
      }
      if (next === undefined) return;
      e.preventDefault();
      // Roving focus; activation stays on Enter/Space (manual activation).
      const target = buttons[next];
      if (target) {
        for (const x of buttons) x.tabIndex = x === target ? 0 : -1;
        target.focus();
      }
    });
  }
  win.addEventListener('hashchange', resolveHash);
  // In-document links to sections in another tab ("From:" links, deep links).
  doc.addEventListener('click', (e) => {
    const a = (e.target as Element | null)?.closest?.('a[href^="#sec-"]');
    if (!a) return;
    const id = (a.getAttribute('href') ?? '').slice(1);
    const k = tabOfSection(id);
    if (k && k !== current) activateTab(k, { history: false });
  });

  // 07 §12 item 6: --eli5-tabbar-h tracks the sticky bar's height.
  const setBarHeight = (): void => {
    if (bar) doc.documentElement.style.setProperty('--eli5-tabbar-h', `${bar.offsetHeight || 44}px`);
  };
  setBarHeight();
  const RO = (win as unknown as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
  if (RO && bar) new RO(setBarHeight).observe(bar);

  resolveHash();
  return {
    keys,
    active: () => current,
    activateTab,
    tabOfSection,
    panel: (k) => panels.get(k),
    onChange: (cb) => {
      listeners.push(cb);
    },
  };
}
