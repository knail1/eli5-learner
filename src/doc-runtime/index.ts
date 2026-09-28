/**
 * Runtime inlined into every generated document (07 §2, §14). Classic IIFE, no imports at run
 * time, no network. Every module is isolated so a failure leaves its no-JS fallback in place.
 */
import './index.css';
import { initCloseButtons, initFocusHandoff, initLinks, initScroll } from './app';
import { getBridge } from './bridge';
import { initCharts, initFigures, initPrint, initSteppers } from './components';
import { initEnhancements } from './enhancements';
import { initGlossary, type GlossaryApi } from './glossary';
import { initSelection, type SelectionController } from './selection';
import { initSelectionZones } from './selection/zones';
import { initTabs, type TabsApi } from './tabs';
import { applyStoredTheme, initThemeToggle } from './theme';

export interface RuntimeHandle {
  tabs?: TabsApi;
  glossary?: GlossaryApi;
  selection?: SelectionController;
  inApp: boolean;
}

function safe<T>(name: string, fn: () => T): T | undefined {
  try {
    return fn();
  } catch (e) {
    console.error(`eli5 runtime: ${name} failed`, e);
    return undefined;
  }
}

/** 07 §14 boot order. */
export function boot(win: Window = window, doc: Document = document): RuntimeHandle {
  doc.documentElement.classList.add('js');
  safe('theme', () => applyStoredTheme(doc, win));
  const tabs = safe('tabs', () => initTabs(doc, win));
  const glossary = safe('glossary', () => initGlossary(doc, win, tabs));
  safe('charts', () => initCharts(doc));
  safe('stepper', () => initSteppers(doc));
  safe('figure', () => initFigures(doc));
  safe('print', () => initPrint(win, doc));
  safe('theme-toggle', () => initThemeToggle(doc, win));
  safe('enhancements', () => initEnhancements(doc, win));
  safe('selection-zones', () => initSelectionZones(doc));
  const bridge = getBridge(win);
  const handle: RuntimeHandle = { inApp: bridge !== undefined };
  if (tabs) handle.tabs = tabs;
  if (glossary) handle.glossary = glossary;
  if (bridge) {
    const selection = safe('selection', () => initSelection(doc, win, bridge, tabs));
    if (selection) handle.selection = selection;
    safe('close-buttons', () => initCloseButtons(doc, bridge));
    if (tabs) safe('scroll', () => initScroll(doc, win, bridge, tabs));
    if (tabs) safe('focus-handoff', () => initFocusHandoff(doc, win, tabs));
    safe('links', () => initLinks(doc, bridge));
  }
  return handle;
}

if (typeof document !== 'undefined' && document.documentElement.hasAttribute('data-eli5-format')) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => boot(), { once: true });
  else boot();
}
