// In-app only behavior (07 §12 items 5-6, §14 step 3): tab close buttons, scroll-to, external
// link interception. Never installed in a plain browser.
import type { DocBridge } from './bridge';
import type { TabsApi } from './tabs';

const CONFIRM_MS = 3000;
const FLASH_MS = 1500;

/** Close buttons on section ELI5 tabs only, with the two-step inline confirm (08 §7.2). */
export function initCloseButtons(doc: Document, bridge: DocBridge): void {
  for (const btn of Array.from(
    doc.querySelectorAll<HTMLButtonElement>('nav.tabbar button.tab-close[data-close-tab]'),
  )) {
    const key = btn.dataset.closeTab ?? '';
    if (!/^sx[0-9a-f]{6}$/.test(key)) continue;
    btn.hidden = false;
    const label = btn.textContent ?? '×';
    let timer: ReturnType<typeof setTimeout> | undefined;
    const revert = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      btn.removeAttribute('data-confirm');
      btn.textContent = label;
    };
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (btn.hasAttribute('data-confirm')) {
        revert();
        void bridge.closeTab(key);
        return;
      }
      btn.setAttribute('data-confirm', '');
      btn.textContent = 'Delete?';
      timer = setTimeout(revert, CONFIRM_MS);
    });
    btn.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') revert();
    });
  }
}

/** Flashes `el` once (08 §7.4 step 5); the CSS keeps a static outline under reduced motion. */
function flash(el: Element): void {
  el.classList.add('eli5-flash');
  setTimeout(() => el.classList.remove('eli5-flash'), FLASH_MS);
}

/**
 * 08 §7.4 step 5-6: activate, scroll under the tab bar, flash, focus the heading. With an `anchorId`
 * that resolves inside the activated tab (an answer box, 08 Ask), that element is centred, flashed
 * and focused instead, and an answer box opens its question.
 */
export function initScroll(doc: Document, win: Window, bridge: DocBridge, tabs: TabsApi): void {
  bridge.onScrollTo((e) => {
    const section = e.sectionId ? doc.getElementById(e.sectionId) : null;
    const anchor = e.anchorId ? doc.getElementById(e.anchorId) : null;
    const anchorSection = anchor?.closest('section[data-section-id]')?.id;
    const key =
      e.tabKey ??
      (e.sectionId ? tabs.tabOfSection(e.sectionId) : anchorSection ? tabs.tabOfSection(anchorSection) : undefined);
    if (!key || !tabs.activateTab(key, { history: false }) || (e.sectionId && !section)) {
      tabs.activateTab(tabs.keys()[0] ?? 'indepth', { history: false });
      return;
    }
    const panel = tabs.panel(key);
    const box = anchor && panel?.contains(anchor) ? (anchor as HTMLElement) : null;
    const target = section ?? panel;
    const raf =
      typeof win.requestAnimationFrame === 'function'
        ? win.requestAnimationFrame.bind(win)
        : (cb: () => void) => setTimeout(cb, 0);
    raf(() => {
      if (box) {
        if (box.classList.contains('qa')) {
          const q = box.querySelector<HTMLDetailsElement>('details.qa-q');
          if (q) q.open = true;
        }
        box.scrollIntoView?.({ block: 'center' });
        if (e.flash) flash(box);
        box.tabIndex = -1;
        box.focus({ preventScroll: true });
        return;
      }
      target?.scrollIntoView?.({ block: 'start' });
      if (section && e.flash) flash(section);
      const h = section?.querySelector<HTMLElement>(':scope > h2');
      if (h) {
        h.tabIndex = -1;
        h.focus({ preventScroll: true });
      }
    });
  });
}

/**
 * Viewer focus handoff (11 §12): when F6 focuses the view and nothing in the document has focus
 * yet, focus the active tab so keyboard users land somewhere visible.
 */
export function initFocusHandoff(doc: Document, win: Window, tabs: TabsApi): void {
  win.addEventListener('focus', () => {
    if (doc.activeElement && doc.activeElement !== doc.body) return;
    const key = tabs.active();
    if (key) tabs.activateTab(key, { history: false, focus: true });
  });
}

/** External links open in the system browser via the bridge (07 §6.3). */
export function initLinks(doc: Document, bridge: DocBridge): void {
  doc.addEventListener('click', (e) => {
    const a = (e.target as Element | null)?.closest?.('a[href]');
    const href = a?.getAttribute('href') ?? '';
    if (!/^(https?:|mailto:)/i.test(href)) return;
    e.preventDefault();
    void bridge.openExternal(href);
  });
}
