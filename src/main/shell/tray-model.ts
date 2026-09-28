import type { MenuItemConstructorOptions } from 'electron';
import type { CatalogEntry } from '../../preload/contract';

/** Tray menu model (11 §4.1). Pure; the Electron side lives in tray.ts. */

export interface TrayEntry {
  slug: string;
  label: string;
}

export interface TrayModel {
  /** 0..3 finished documents, newest first. */
  recent: TrayEntry[];
  /** Queued + running, create and section jobs. */
  activeJobs: number;
}

export interface TrayActions {
  openDocument(slug: string): void;
  showWindow(): void;
  openSettings(): void;
  quit(): void;
}

const MAX_RECENT = 3;
const MAX_LABEL = 40;
// C0/C1 controls and bidi embedding/override/isolate marks (11 §4.2 edge cases).
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/g;

/** Strips control and bidi characters and truncates to 40 characters plus "…". */
export function trayLabel(title: string): string {
  const clean = title.replace(UNSAFE_CHARS, '').replace(/\s+/g, ' ').trim() || 'Untitled';
  const chars = Array.from(clean);
  return chars.length > MAX_LABEL ? `${chars.slice(0, MAX_LABEL).join('').trimEnd()}…` : clean;
}

/** Library order (11 §5.2): createdAt descending, ties by title ascending. Same order as the sidebar. */
export function libraryOrder(a: CatalogEntry, b: CatalogEntry): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  return a.title.localeCompare(b.title);
}

export function recentFromCatalog(entries: readonly CatalogEntry[]): TrayEntry[] {
  return [...entries]
    .sort(libraryOrder)
    .slice(0, MAX_RECENT)
    .map((e) => ({ slug: e.topicSlug, label: trayLabel(e.title) }));
}

const jobs = (n: number): string => `${n} ${n === 1 ? 'job' : 'jobs'}`;

export function trayTooltip(activeJobs: number): string {
  return activeJobs > 0 ? `ELI5 Learner — ${jobs(activeJobs)} running` : 'ELI5 Learner';
}

export function quitLabel(activeJobs: number): string {
  return activeJobs > 0 ? `Quit (${jobs(activeJobs)} will resume)` : 'Quit';
}

export function trayMenuTemplate(m: TrayModel, a: TrayActions): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = [];
  if (m.recent.length === 0) items.push({ label: 'No documents yet', enabled: false });
  for (const e of m.recent.slice(0, MAX_RECENT)) {
    items.push({ label: e.label, click: () => a.openDocument(e.slug) });
  }
  items.push({ type: 'separator' });
  if (m.activeJobs > 0) items.push({ label: `${jobs(m.activeJobs)} running`, enabled: false });
  items.push({ label: 'Open ELI5 Learner', click: () => a.showWindow() });
  items.push({ label: 'Settings…', click: () => a.openSettings() });
  items.push({ type: 'separator' });
  items.push({ label: quitLabel(m.activeJobs), click: () => a.quit() });
  return items;
}
