import { describe, expect, it } from 'vitest';
import type { CatalogEntry, JobSnapshot, SourceInput } from '../../../src/preload/contract';
import type { IpcError, StartJobRequest, UiRoute } from '../../../src/preload/contract';
import { loadRenderer } from './harness';

// Renderer modules sit outside config/tsconfig.node.json, so they load by runtime specifier (see harness).
interface Draft {
  draftId: string;
  inputs: SourceInput[];
  urlText: string;
  clarifying: string;
  glossary: boolean;
}
type Key = { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean };

const { matchShortcut } = await loadRenderer<{ matchShortcut(k: Key): { id: string; index?: number } | null }>(
  'a11y/shortcuts.ts',
);
const {
  chipLabel,
  clarifyRows,
  commitUrlText,
  draftHasContent,
  filesToRelease,
  isHttpUrl,
  isTextField,
  newDraft,
  startErrorMessage,
  startMode,
  startRequest,
} = await loadRenderer<{
  chipLabel(i: SourceInput): string;
  draftHasContent(d: Draft): boolean;
  filesToRelease(leaving: SourceInput[], remaining: SourceInput[]): SourceInput[];
  startMode(run: { jobId: string; status: JobSnapshot['status'] } | null): 'start' | 'restart';
  clarifyRows(t: string): number;
  commitUrlText(t: string): { added: SourceInput[]; invalid: string[] };
  isHttpUrl(s: string): boolean;
  isTextField(el: EventTarget | null): boolean;
  newDraft(glossary: boolean): Draft;
  startErrorMessage(e: IpcError): string;
  startRequest(d: Draft, inputs: SourceInput[]): StartJobRequest;
}>('input/draft.ts');
const { filterCatalog, relativeDate, sortCatalog, updatedLabel } = await loadRenderer<{
  filterCatalog(e: CatalogEntry[], q: string): CatalogEntry[];
  relativeDate(iso: string, now?: number): string;
  sortCatalog(e: CatalogEntry[]): CatalogEntry[];
  updatedLabel(iso: string, now?: number): string;
}>('library/order.ts');
const { resolveRoute, startupRoute } = await loadRenderer<{
  resolveRoute(r: UiRoute, c: CatalogEntry[] | null): UiRoute;
  startupRoute(c: CatalogEntry[] | null, last: string | null): UiRoute;
}>('routes.ts');
const { settingsLinkParts, sortJobs, upsertJob } = await loadRenderer<{
  settingsLinkParts(line: string): [string, string] | null;
  sortJobs(j: JobSnapshot[]): JobSnapshot[];
  upsertJob(j: JobSnapshot[], s: JobSnapshot): JobSnapshot[];
}>('status/jobs.ts');

const entry = (title: string, createdAt: string, summary = ''): CatalogEntry => ({
  id: `id-${title}`,
  title,
  topicSlug: title.toLowerCase().replace(/\W+/g, '-'),
  createdAt,
  updatedAt: createdAt,
  summary,
  summarySource: 'fallback',
  tabCount: 2,
  mergedFromCount: 0,
});

describe('library order (11 §5.2)', () => {
  const list = [
    entry('Old', '2026-01-01T00:00:00.000Z', 'Example Widgets Inc. pricing'),
    entry('Beta', '2026-03-01T00:00:00.000Z'),
    entry('Alpha', '2026-03-01T00:00:00.000Z'),
    entry('Newest', '2026-04-01T00:00:00.000Z'),
  ];

  it('is newest first by createdAt, ties by title', () => {
    expect(sortCatalog(list).map((e) => e.title)).toEqual(['Newest', 'Alpha', 'Beta', 'Old']);
  });

  it('filters case-insensitively on title and summary', () => {
    expect(filterCatalog(list, 'ALP').map((e) => e.title)).toEqual(['Alpha']);
    expect(filterCatalog(list, 'widgets').map((e) => e.title)).toEqual(['Old']);
    expect(filterCatalog(list, '  ')).toHaveLength(4);
  });

  it('formats compact relative dates', () => {
    const now = Date.parse('2026-04-10T12:00:00.000Z');
    expect(relativeDate('2026-04-10T11:59:30.000Z', now)).toBe('now');
    expect(relativeDate('2026-04-10T11:58:00.000Z', now)).toBe('2m');
    expect(relativeDate('2026-04-10T07:00:00.000Z', now)).toBe('5h');
    expect(relativeDate('2026-04-07T12:00:00.000Z', now)).toBe('3d');
    expect(relativeDate('2026-03-30T12:00:00.000Z', now)).toBe('1w');
    expect(relativeDate('2026-03-04T12:00:00.000Z', now)).toBe('Mar 4');
    expect(relativeDate('2025-03-04T12:00:00.000Z', now)).toBe('Mar 4, 2025');
    expect(relativeDate('garbage', now)).toBe('');
    expect(updatedLabel('2026-04-07T12:00:00.000Z', now)).toBe('Updated 3d ago');
  });
});

describe('input draft (11 §5.4)', () => {
  it('mints draft and input ids in the documented shape', () => {
    const d = newDraft(true);
    expect(d.draftId).toMatch(/^draft-[0-9a-f]{8}$/);
    expect(d).toMatchObject({ inputs: [], urlText: '', clarifying: '', glossary: true });
    const { added } = commitUrlText('https://example.com');
    expect(added[0]?.id).toMatch(/^in-[0-9a-f]{8}$/);
  });

  it('commits http(s) tokens and keeps everything else as invalid', () => {
    const r = commitUrlText('https://example.com/a  http://example.org\nABC-123 ftp://x.y');
    expect(r.added.map((i) => (i.kind === 'url' ? i.url : ''))).toEqual([
      'https://example.com/a',
      'http://example.org',
    ]);
    expect(r.added.every((i) => i.origin === 'url-field')).toBe(true);
    expect(r.invalid).toEqual(['ABC-123', 'ftp://x.y']);
    expect(isHttpUrl('https://')).toBe(false);
  });

  it('builds the jobs:start request, adding draftId only for staged pastes', () => {
    const d = { ...newDraft(false), clarifying: 'pricing' };
    const url: SourceInput = { id: 'in-00000001', kind: 'url', origin: 'url-field', url: 'https://example.com' };
    expect(startRequest(d, [url])).toEqual({ inputs: [url], options: { clarifyingInput: 'pricing', glossary: false } });
    const img: SourceInput = {
      id: 'in-00000002',
      kind: 'image',
      origin: 'paste',
      stagedPath: '/tmp/x.png',
      mediaType: 'image/png',
      preview: 'Pasted image 14:02',
    };
    expect(startRequest(d, [img]).draftId).toBe(d.draftId);
    expect(chipLabel(img)).toBe('Pasted image 14:02');
    expect(chipLabel({ id: 'a', kind: 'file', origin: 'drop', path: '/Users/x/deck.pptx' })).toBe('deck.pptx');
  });

  it('a start keeps the draft: Restart while its run is queued or running, else Start (11 §5.4)', () => {
    expect(startMode(null)).toBe('start');
    for (const status of ['queued', 'reading', 'extracting', 'generating', 'saving'] as const) {
      expect(startMode({ jobId: 'job-1', status })).toBe('restart');
    }
    for (const status of ['done', 'failed'] as const) expect(startMode({ jobId: 'job-1', status })).toBe('start');
  });

  it('Clear is enabled only when the draft has something in it', () => {
    const d = newDraft(true);
    expect(draftHasContent(d)).toBe(false);
    expect(draftHasContent({ ...d, urlText: '  ' })).toBe(false);
    expect(draftHasContent({ ...d, urlText: 'https://e' })).toBe(true);
    expect(draftHasContent({ ...d, clarifying: 'pricing' })).toBe(true);
    const url: SourceInput = { id: 'in-00000001', kind: 'url', origin: 'url-field', url: 'https://example.com' };
    expect(draftHasContent({ ...d, inputs: [url] })).toBe(true);
  });

  it('releases a file chip only when no remaining chip names the same path (06 §11)', () => {
    const a: SourceInput = { id: 'in-00000001', kind: 'file', origin: 'drop', path: '/x/a.pdf' };
    const a2: SourceInput = { id: 'in-00000002', kind: 'file', origin: 'drop', path: '/x/a.pdf' };
    const b: SourceInput = { id: 'in-00000003', kind: 'file', origin: 'paste', path: '/x/b.pdf' };
    const url: SourceInput = { id: 'in-00000004', kind: 'url', origin: 'url-field', url: 'https://example.com' };
    expect(filesToRelease([a], [a2, b])).toEqual([]);
    expect(filesToRelease([a, b, url], [])).toEqual([a, b]);
    expect(filesToRelease([b], [a])).toEqual([b]);
  });

  it('maps edition errors to the documented copy', () => {
    expect(startErrorMessage({ code: 'E_NOT_AVAILABLE_IN_EDITION', message: 'x' })).toBe(
      'Requires the enterprise edition',
    );
    expect(startErrorMessage({ code: 'E_INTERNAL', message: 'Not implemented yet' })).toBe('Not implemented yet');
  });

  it('knows which elements keep native paste', () => {
    const text = document.createElement('input');
    const box = document.createElement('input');
    box.type = 'checkbox';
    expect(isTextField(text)).toBe(true);
    expect(isTextField(document.createElement('textarea'))).toBe(true);
    expect(isTextField(box)).toBe(false);
    expect(isTextField(document.body)).toBe(false);
    expect(isTextField(null)).toBe(false);
  });

  it('grows the specifics field from 1 to 6 rows', () => {
    expect(clarifyRows('')).toBe(1);
    expect(clarifyRows('a\nb\nc')).toBe(3);
    expect(clarifyRows('\n'.repeat(20))).toBe(6);
  });
});

describe('jobs (11 §5.5)', () => {
  const job = (id: string, createdAt: string, statusLine = 'Queued'): JobSnapshot => ({
    id,
    kind: 'create',
    status: 'queued',
    statusLine,
    createdAt,
    skippedCount: 0,
    canCancel: true,
    canRetry: false,
    canDismiss: false,
  });

  it('keeps the newest line at the bottom and replaces by id', () => {
    const list = sortJobs([job('b', '2026-01-02T00:00:00Z'), job('a', '2026-01-01T00:00:00Z')]);
    expect(list.map((j) => j.id)).toEqual(['a', 'b']);
    const next = upsertJob(list, { ...job('a', '2026-01-01T00:00:00Z'), statusLine: 'Reading sources' });
    expect(next.map((j) => j.statusLine)).toEqual(['Reading sources', 'Queued']);
    expect(upsertJob(next, job('c', '2026-01-03T00:00:00Z')).map((j) => j.id)).toEqual(['a', 'b', 'c']);
  });

  it('splits an LLM_AUTH line around Settings', () => {
    expect(settingsLinkParts('Failed: API key rejected. Check Settings')).toEqual([
      'Failed: API key rejected. Check ',
      '',
    ]);
    expect(settingsLinkParts('Done: Topic')).toBeNull();
  });
});

describe('routes (11 §6)', () => {
  const cat = [entry('Topic A', '2026-01-01T00:00:00Z')];
  it('opens the last document only if it still exists', () => {
    expect(startupRoute(cat, 'topic-a')).toEqual({ view: 'doc', slug: 'topic-a' });
    expect(startupRoute(cat, 'gone')).toEqual({ view: 'welcome' });
    expect(startupRoute(null, 'topic-a')).toEqual({ view: 'welcome' });
  });

  it('shows not-found for a doc route missing from a loaded catalog', () => {
    expect(resolveRoute({ view: 'doc', slug: 'gone' }, cat)).toEqual({ view: 'not-found', slug: 'gone' });
    expect(resolveRoute({ view: 'doc', slug: 'gone' }, null)).toEqual({ view: 'doc', slug: 'gone' });
  });
});

describe('shortcuts (11 §9)', () => {
  const k = (key: string, mods: Partial<Record<'metaKey' | 'shiftKey' | 'ctrlKey' | 'altKey', boolean>> = {}) => ({
    key,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...mods,
  });

  it('matches the table', () => {
    expect(matchShortcut(k('l', { metaKey: true }))?.id).toBe('focus-url');
    expect(matchShortcut(k('n', { metaKey: true }))?.id).toBe('new-draft');
    expect(matchShortcut(k(',', { metaKey: true }))?.id).toBe('settings');
    expect(matchShortcut(k('\\', { metaKey: true }))?.id).toBe('toggle-sidebar');
    expect(matchShortcut(k('f', { metaKey: true }))?.id).toBe('find');
    expect(matchShortcut(k('f', { metaKey: true, altKey: true }))?.id).toBe('focus-filter');
    expect(matchShortcut(k('g', { metaKey: true }))?.id).toBe('find-next');
    expect(matchShortcut(k('G', { metaKey: true, shiftKey: true }))?.id).toBe('find-previous');
    expect(matchShortcut(k('[', { metaKey: true }))?.id).toBe('prev-doc');
    expect(matchShortcut(k(']', { metaKey: true }))?.id).toBe('next-doc');
    expect(matchShortcut(k('3', { metaKey: true }))).toEqual({ id: 'nth-doc', index: 2 });
    expect(matchShortcut(k('F6'))?.id).toBe('next-region');
    expect(matchShortcut(k('F6', { shiftKey: true }))?.id).toBe('prev-region');
  });

  it('ignores plain typing and other modifiers', () => {
    expect(matchShortcut(k('l'))).toBeNull();
    expect(matchShortcut(k('l', { metaKey: true, shiftKey: true }))).toBeNull();
    expect(matchShortcut(k('0', { metaKey: true }))).toBeNull();
  });
});
