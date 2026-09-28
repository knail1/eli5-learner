import { describe, expect, it, vi } from 'vitest';
import type { CatalogEntry } from '../../../../src/preload/contract';
import {
  quitLabel,
  recentFromCatalog,
  trayLabel,
  trayMenuTemplate,
  trayTooltip,
  type TrayActions,
} from '../../../../src/main/shell/tray-model';

const entry = (title: string, createdAt: string): CatalogEntry => ({
  id: `id-${title}`,
  title,
  topicSlug: title.toLowerCase().replace(/\s+/g, '-'),
  createdAt,
  updatedAt: createdAt,
  summary: '',
  summarySource: 'fallback',
  tabCount: 2,
  mergedFromCount: 0,
});

const actions = () => ({
  openDocument: vi.fn<TrayActions['openDocument']>(),
  showWindow: vi.fn<TrayActions['showWindow']>(),
  openSettings: vi.fn<TrayActions['openSettings']>(),
  quit: vi.fn<TrayActions['quit']>(),
});

const labels = (items: ReturnType<typeof trayMenuTemplate>) =>
  items.map((i) => (i.type === 'separator' ? '---' : `${i.label}${i.enabled === false ? ' (disabled)' : ''}`));

describe('trayMenuTemplate (11 §4.1)', () => {
  it('empty library, no jobs', () => {
    expect(labels(trayMenuTemplate({ recent: [], activeJobs: 0 }, actions()))).toEqual([
      'No documents yet (disabled)',
      '---',
      'Open ELI5 Learner',
      'Settings…',
      '---',
      'Quit',
    ]);
  });

  it('recent documents and active jobs', () => {
    const m = {
      recent: [
        { slug: 'a', label: 'Topic A' },
        { slug: 'b', label: 'Topic B' },
      ],
      activeJobs: 2,
    };
    expect(labels(trayMenuTemplate(m, actions()))).toEqual([
      'Topic A',
      'Topic B',
      '---',
      '2 jobs running (disabled)',
      'Open ELI5 Learner',
      'Settings…',
      '---',
      'Quit (2 jobs will resume)',
    ]);
  });

  it('wires every action', () => {
    const a = actions();
    const items = trayMenuTemplate({ recent: [{ slug: 'a', label: 'Topic A' }], activeJobs: 0 }, a);
    const click = (label: string) =>
      items.find((i) => i.label === label)?.click?.({} as Electron.MenuItem, undefined, {} as Electron.KeyboardEvent);
    click('Topic A');
    click('Open ELI5 Learner');
    click('Settings…');
    click('Quit');
    expect(a.openDocument).toHaveBeenCalledWith('a');
    expect(a.showWindow).toHaveBeenCalledOnce();
    expect(a.openSettings).toHaveBeenCalledOnce();
    expect(a.quit).toHaveBeenCalledOnce();
  });
});

describe('recentFromCatalog', () => {
  it('takes the three newest by createdAt, ties by title', () => {
    const r = recentFromCatalog([
      entry('Old', '2026-01-01T00:00:00.000Z'),
      entry('Beta', '2026-03-01T00:00:00.000Z'),
      entry('Alpha', '2026-03-01T00:00:00.000Z'),
      entry('Newest', '2026-04-01T00:00:00.000Z'),
    ]);
    expect(r.map((e) => e.label)).toEqual(['Newest', 'Alpha', 'Beta']);
    expect(r[0]).toEqual({ slug: 'newest', label: 'Newest' });
  });
});

describe('labels', () => {
  it('truncates to 40 characters plus an ellipsis', () => {
    const long = 'Example Widgets Inc. quarterly review and roadmap for next year';
    const l = trayLabel(long);
    expect(l.endsWith('…')).toBe(true);
    expect(Array.from(l).length).toBeLessThanOrEqual(41);
    expect(trayLabel('Short')).toBe('Short');
  });

  it('strips control and bidi characters', () => {
    expect(trayLabel('Safe‮txt.exe\u0007 title')).toBe('Safetxt.exe title');
    expect(trayLabel('‏\u0000')).toBe('Untitled');
  });

  it('tooltip and quit label follow the active job count', () => {
    expect(trayTooltip(0)).toBe('ELI5 Learner');
    expect(trayTooltip(1)).toBe('ELI5 Learner — 1 job running');
    expect(quitLabel(0)).toBe('Quit');
    expect(quitLabel(1)).toBe('Quit (1 job will resume)');
    expect(quitLabel(3)).toBe('Quit (3 jobs will resume)');
  });
});
