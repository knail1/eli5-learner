import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatalogEntry, JobSnapshot, MergeSuggestion } from '../../../src/preload/contract';
import {
  button,
  click,
  installFakeApi,
  key,
  loadRenderer,
  ok,
  render,
  type,
  type Component,
  type FakeApi,
} from './harness';

const { StatusArea } = await loadRenderer<{ StatusArea: Component }>('status/StatusArea.tsx');
const { SuggestionsPanel } = await loadRenderer<{ SuggestionsPanel: Component }>('suggestions/SuggestionsPanel.tsx');
const { LibrarySidebar } = await loadRenderer<{ LibrarySidebar: Component }>('library/LibrarySidebar.tsx');
const { AnnouncerProvider } = await loadRenderer<{ AnnouncerProvider: Component }>('a11y/Announcer.tsx');

let fake: FakeApi;
beforeEach(() => {
  fake = installFakeApi();
});

const withAnnouncer = (c: Component) =>
  function Wrapped(props: Record<string, unknown>) {
    return createElement(AnnouncerProvider, null, createElement(c, props));
  };

const job = (over: Partial<JobSnapshot>): JobSnapshot => ({
  id: 'job-1',
  kind: 'create',
  status: 'reading',
  statusLine: 'Reading sources (1 of 2)',
  createdAt: '2026-01-01T00:00:00.000Z',
  skippedCount: 0,
  canCancel: true,
  canRetry: false,
  canDismiss: false,
  ...over,
});

describe('StatusArea (11 §5.5)', () => {
  it('is blank (but present) when there are no jobs or the handler is not there yet', async () => {
    const host = await render(withAnnouncer(StatusArea), { onOpenDoc: vi.fn(), onOpenSettings: vi.fn() });
    expect(host.querySelector('section[aria-label="Jobs"]')).not.toBeNull();
    expect(host.querySelectorAll('.job-line')).toHaveLength(0);
  });

  it('renders pipeline lines verbatim, newest at the bottom, and updates live', async () => {
    fake.api.jobs.list = async () =>
      ok([job({ id: 'b', createdAt: '2026-01-02T00:00:00Z', statusLine: 'Queued' }), job({ id: 'a' })]);
    const host = await render(withAnnouncer(StatusArea), { onOpenDoc: vi.fn(), onOpenSettings: vi.fn() });
    const lines = () => Array.from(host.querySelectorAll('.job-text')).map((e) => e.textContent);
    expect(lines()).toEqual(['Reading sources (1 of 2)', 'Queued']);

    fake.emit('jobs', job({ id: 'a', status: 'generating', statusLine: 'Generating in-depth explainer' }));
    expect(lines()).toEqual(['Generating in-depth explainer', 'Queued']);
    // Intermediate stages are not announced.
    expect(host.querySelector('[data-testid="announcer-polite"]')?.textContent).toBe('');
  });

  it('offers Cancel, and Retry/Dismiss on failures, inline', async () => {
    fake.api.jobs.list = async () => ok([job({})]);
    const host = await render(withAnnouncer(StatusArea), { onOpenDoc: vi.fn(), onOpenSettings: vi.fn() });
    await click(button(host, 'Cancel'));
    expect(fake.api.jobs.cancel).toHaveBeenCalledWith('job-1');

    fake.emit(
      'jobs',
      job({
        status: 'failed',
        statusLine: 'Failed: API key rejected. Check Settings',
        failureCode: 'LLM_AUTH',
        canCancel: false,
        canRetry: true,
        canDismiss: true,
      }),
    );
    expect(button(host, 'Cancel')).toBeUndefined();
    expect(host.querySelector('[data-testid="announcer-assertive"]')?.textContent).toContain('API key rejected');
    await click(button(host, 'Retry'));
    expect(fake.api.jobs.retry).toHaveBeenCalledWith('job-1');
    await click(button(host, 'Dismiss'));
    expect(host.querySelectorAll('.job-line')).toHaveLength(0);
  });

  it('links "Settings" on an LLM_AUTH line and opens done documents', async () => {
    const onOpenDoc = vi.fn();
    const onOpenSettings = vi.fn();
    fake.api.jobs.list = async () =>
      ok([
        job({ id: 'f', status: 'failed', statusLine: 'Failed: API key rejected. Check Settings', canCancel: false }),
        job({
          id: 'd',
          createdAt: '2026-01-03T00:00:00Z',
          status: 'done',
          statusLine: 'Done: How DNS works',
          finishedAt: new Date().toISOString(), // within its 10 minutes (06 §6)
          result: { docId: 'x', topicSlug: 'how-dns-works', title: 'How DNS works' },
          canCancel: false,
          canDismiss: true,
        }),
      ]);
    const host = await render(withAnnouncer(StatusArea), { onOpenDoc, onOpenSettings });
    await click(button(host, 'Settings'));
    expect(onOpenSettings).toHaveBeenCalledOnce();
    await click(button(host, 'Done: How DNS works'));
    expect(onOpenDoc).toHaveBeenCalledWith('how-dns-works');
  });

  it('announces Done politely', async () => {
    fake.api.jobs.list = async () => ok([job({})]);
    const host = await render(withAnnouncer(StatusArea), { onOpenDoc: vi.fn(), onOpenSettings: vi.fn() });
    fake.emit(
      'jobs',
      job({
        status: 'done',
        statusLine: 'Done: Topic A',
        result: { docId: 'x', topicSlug: 'topic-a', title: 'Topic A' },
        canCancel: false,
      }),
    );
    expect(host.querySelector('[data-testid="announcer-polite"]')?.textContent).toBe('Done: Topic A');
  });
});

const suggestion = (over: Partial<MergeSuggestion> = {}): MergeSuggestion => ({
  id: 's1',
  createdAt: '2026-01-01T00:00:00Z',
  status: 'pending',
  source: { id: 'n', slug: 'new-doc', title: 'New doc' },
  target: { id: 't', slug: 'target-doc', title: 'Target doc' },
  score: 0.8,
  reason: 'overlap',
  scorer: 'lexical+llm',
  ...over,
});

describe('SuggestionsPanel (11 §5.6)', () => {
  it('is hidden when there are no suggestions', async () => {
    const host = await render(withAnnouncer(SuggestionsPanel), { onOpenDoc: vi.fn() });
    expect(host.textContent).not.toContain('Suggestions');
  });

  it('shows Merge in / Keep separate and never steals focus', async () => {
    const onOpenDoc = vi.fn();
    const host = await render(withAnnouncer(SuggestionsPanel), { onOpenDoc });
    const focused = document.activeElement;
    fake.emit('suggestions', { suggestions: [suggestion(), suggestion({ id: 's2', status: 'dismissed' })] });
    expect(host.textContent).toContain('Suggestions (1)');
    expect(host.textContent).toContain('This looks related to Target doc. Merge it in or keep it separate?');
    expect(document.activeElement).toBe(focused);
    expect(host.querySelector('[data-testid="announcer-polite"]')?.textContent).toBe('New suggestion');

    await click(button(host, 'Target doc'));
    expect(onOpenDoc).toHaveBeenCalledWith('target-doc');

    fake.api.suggestions.accept = vi.fn(() => new Promise(() => {})) as typeof fake.api.suggestions.accept;
    await click(button(host, 'Merge in'));
    expect(fake.api.suggestions.accept).toHaveBeenCalledWith('s1');
    expect(host.textContent).toContain('Merging…');
  });

  it('Keep separate dismisses; errors render inline', async () => {
    fake.api.suggestions.list = async () => ok([suggestion()]);
    const host = await render(withAnnouncer(SuggestionsPanel), { onOpenDoc: vi.fn() });
    await click(button(host, 'Keep separate'));
    expect(fake.api.suggestions.dismiss).toHaveBeenCalledWith('s1');
    expect(host.textContent).toContain('Not implemented yet');
  });
});

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

describe('LibrarySidebar (11 §5.2, §8)', () => {
  const base = { error: null, selectedSlug: null, onOpen: vi.fn(), onRetry: vi.fn() };

  it('shows the empty state', async () => {
    const host = await render(LibrarySidebar, { ...base, entries: [] });
    expect(host.textContent).toContain('Your finished documents will appear here');
  });

  it('shows load errors with Retry', async () => {
    const onRetry = vi.fn();
    const host = await render(LibrarySidebar, { ...base, entries: null, error: 'x', onRetry });
    expect(host.textContent).toContain('Could not load the Library');
    await click(button(host, 'Retry'));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('lists entries in the given order, marks the selection, filters, and opens', async () => {
    const onOpen = vi.fn();
    const entries = [
      entry('Topic B', '2026-02-01T00:00:00Z', 'about widgets'),
      entry('Topic A', '2026-01-01T00:00:00Z'),
    ];
    const host = await render(LibrarySidebar, { ...base, entries, selectedSlug: 'topic-a', onOpen });
    const titles = () => Array.from(host.querySelectorAll('.item-title')).map((e) => e.textContent);
    expect(titles()).toEqual(['Topic B', 'Topic A']);
    expect(host.querySelector('[aria-current="page"] .item-title')?.textContent).toBe('Topic A');
    expect(host.querySelector('.library-item')?.getAttribute('title')).toBe('about widgets');

    const filter = host.querySelector<HTMLInputElement>('input[type="search"]');
    await type(filter, 'WIDGET');
    expect(titles()).toEqual(['Topic B']);
    await type(filter, 'nothing');
    expect(host.textContent).toContain('No documents match ‘nothing’');
    await key(filter, 'Escape');
    expect(titles()).toHaveLength(2);

    await click(host.querySelector('.library-item'));
    expect(onOpen).toHaveBeenCalledWith('topic-b');
    await key(host.querySelector('.library-item'), 'F10', { shiftKey: true });
    expect(fake.api.app.contextMenu).toHaveBeenCalledWith({ kind: 'library-item', slug: 'topic-b' });
  });

  it('a failed context-menu call shows an inline message next to the item (11 §13)', async () => {
    const entries = [entry('Topic A', '2026-01-01T00:00:00Z')];
    const host = await render(LibrarySidebar, { ...base, entries });
    await key(host.querySelector('.library-item'), 'ContextMenu');
    expect(host.querySelector('li .inline-error')?.textContent).toBe('Not implemented yet');
  });
});
