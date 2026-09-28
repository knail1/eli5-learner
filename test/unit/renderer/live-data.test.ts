import { act, createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatalogEntry, IpcResult, JobSnapshot, SourceInput, StartJobRequest } from '../../../src/preload/contract';
import {
  button,
  click,
  flush,
  installFakeApi,
  key,
  loadRenderer,
  ok,
  render,
  settings,
  type,
  type Component,
  type FakeApi,
} from './harness';

/** M2 wiring of the shell to live pipeline and library data (11 §5.2, §5.4, §5.5, §13; 06 §6, §7). */

const { App } = await loadRenderer<{ App: Component }>('App.tsx');
const { InputZone } = await loadRenderer<{ InputZone: Component }>('input/InputZone.tsx');
const { StatusArea } = await loadRenderer<{ StatusArea: Component }>('status/StatusArea.tsx');
const { AnnouncerProvider } = await loadRenderer<{ AnnouncerProvider: Component }>('a11y/Announcer.tsx');

let fake: FakeApi;
beforeEach(() => {
  try {
    window.localStorage.clear();
  } catch {
    // ignore
  }
  fake = installFakeApi();
});

const withAnnouncer = (c: Component) =>
  function Wrapped(props: Record<string, unknown>) {
    return createElement(AnnouncerProvider, null, createElement(c, props));
  };

const fail = (code: string, message: string) => ({ ok: false, error: { code, message } }) as IpcResult<never>;

const deferred = <T>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};

const job = (over: Partial<JobSnapshot>): JobSnapshot => ({
  id: 'job-1',
  kind: 'create',
  status: 'reading',
  statusLine: 'Reading sources',
  createdAt: '2026-01-01T00:00:00.000Z',
  skippedCount: 0,
  canCancel: true,
  canRetry: false,
  canDismiss: false,
  ...over,
});

const entry = (title: string, createdAt: string): CatalogEntry => ({
  id: `id-${title}`,
  title,
  topicSlug: title.toLowerCase().replace(/\W+/g, '-'),
  createdAt,
  updatedAt: createdAt,
  summary: '',
  summarySource: 'fallback',
  tabCount: 2,
  mergedFromCount: 0,
});

async function mountZone(over: Record<string, unknown> = {}) {
  const host = await render(withAnnouncer(InputZone), {
    glossaryDefault: true,
    provider: 'claude',
    onOpenSettings: () => {},
    ...over,
  });
  return { host, url: host.querySelector<HTMLInputElement>('input[aria-label="URL"]') };
}

function dropEvent(data: { files?: File[]; text?: string; html?: string }): Event {
  const ev = new Event('drop', { bubbles: true, cancelable: true }) as Event & { dataTransfer: unknown };
  ev.dataTransfer = {
    files: data.files ?? [],
    getData: (t: string) => (t === 'text/plain' ? (data.text ?? '') : t === 'text/html' ? (data.html ?? '') : ''),
  };
  return ev;
}

describe('InputZone against live handlers (11 §5.4)', () => {
  it('E_NO_API_KEY from jobs.start keeps the draft and shows the message with a Settings link', async () => {
    fake.api.settings.hasApiKey = async () => ok(true); // key removed between the check and the start
    fake.api.jobs.start = async () => fail('E_NO_API_KEY', 'Add an API key in Settings');
    const onOpenSettings = vi.fn();
    const { host, url } = await mountZone({ onOpenSettings });
    await type(url, 'https://example.com/a');
    await key(url, 'Enter');
    expect(host.querySelector('.start-error')?.textContent).toContain('Add an API key in Settings');
    expect(host.querySelectorAll('.chip')).toHaveLength(1);
    await click(host.querySelector('.start-error button'));
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });

  it('other start errors have no Settings link', async () => {
    fake.api.settings.hasApiKey = async () => ok(true);
    fake.api.jobs.start = async () => fail('E_FORBIDDEN', 'That file is no longer available');
    const { host, url } = await mountZone();
    await type(url, 'https://example.com/a');
    await key(url, 'Enter');
    expect(host.querySelector('.start-error')?.textContent).toBe('That file is no longer available');
    expect(host.querySelector('.start-error button')).toBeNull();
  });

  it('a staged paste sends the draftId it was staged under, and the next draft gets a new one', async () => {
    fake.api.settings.hasApiKey = async () => ok(true);
    const drafts: string[] = [];
    fake.api.sources.readClipboard = async (draftId: string) => {
      drafts.push(draftId);
      const s: SourceInput = {
        id: `in-0000000${drafts.length}`,
        kind: 'text',
        origin: 'paste',
        markup: 'plain',
        stagedPath: '/s/t.txt',
        preview: 'Pasted text',
      };
      return ok([s]);
    };
    const reqs: StartJobRequest[] = [];
    fake.api.jobs.start = async (r: StartJobRequest) => {
      reqs.push(r);
      return ok({ jobId: 'job-1' });
    };
    const { host } = await mountZone();
    await act(async () => {
      document.body.dispatchEvent(new Event('paste', { bubbles: true, cancelable: true }));
    });
    await flush();
    await click(button(host, 'Start'));
    expect(reqs[0]?.draftId).toBe(drafts[0]);
    expect(reqs[0]?.draftId).toMatch(/^draft-[0-9a-f]{8}$/);

    await act(async () => {
      document.body.dispatchEvent(new Event('paste', { bubbles: true, cancelable: true }));
    });
    await flush();
    expect(drafts[1]).toMatch(/^draft-[0-9a-f]{8}$/);
    expect(drafts[1]).not.toBe(drafts[0]);
  });

  it('dropped files resolve through files.pathFor; dropped text is staged under the draft', async () => {
    const { host } = await mountZone();
    await act(async () => {
      window.dispatchEvent(dropEvent({ files: [new File(['x'], 'notes.pdf')] }));
    });
    await flush();
    expect(fake.api.files.pathFor).toHaveBeenCalledOnce();
    expect(host.textContent).toContain('notes.pdf');

    const staged: SourceInput = {
      id: 'in-000000aa',
      kind: 'text',
      origin: 'paste',
      markup: 'plain',
      stagedPath: '/s/d.txt',
      preview: 'Dropped text',
    };
    const stageText = vi.fn(async () => ok(staged));
    fake.api.sources.stageText = stageText;
    await act(async () => {
      window.dispatchEvent(dropEvent({ text: 'some plain words' }));
    });
    await flush();
    expect(stageText).toHaveBeenCalledWith(expect.stringMatching(/^draft-/), 'some plain words', 'plain');
    expect(host.textContent).toContain('Dropped text');
  });

  it('a file whose path cannot be resolved is skipped with an inline hint; the others are added', async () => {
    fake.api.files.pathFor = vi.fn((f: File) => {
      if (f.name === 'bad.bin') throw new Error('no path');
      return `/tmp/${f.name}`;
    });
    const { host } = await mountZone();
    await act(async () => {
      window.dispatchEvent(dropEvent({ files: [new File(['x'], 'bad.bin'), new File(['y'], 'good.txt')] }));
    });
    await flush();
    expect(host.querySelectorAll('.chip')).toHaveLength(1);
    expect(host.textContent).toContain('good.txt');
    expect(host.querySelector('.inline-hint')?.textContent).toContain('Could not add');
  });

  it('a failed clipboard read shows the error inline', async () => {
    fake.api.sources.readClipboard = async () => fail('E_IO', 'Could not read the clipboard');
    const { host } = await mountZone();
    await act(async () => {
      document.body.dispatchEvent(new Event('paste', { bubbles: true, cancelable: true }));
    });
    await flush();
    expect(host.querySelector('.inline-hint')?.textContent).toBe('Could not read the clipboard');
  });
});

describe('StatusArea against live handlers (11 §5.5, §13)', () => {
  const props = { onOpenDoc: vi.fn(), onOpenSettings: vi.fn() };
  const lines = (host: HTMLElement) => Array.from(host.querySelectorAll('.job-text')).map((e) => e.textContent);

  it('a change for an unknown job refetches the full list', async () => {
    const list = vi.fn(async () => ok([job({ id: 'a' })]));
    fake.api.jobs.list = list;
    const host = await render(withAnnouncer(StatusArea), props);
    expect(list).toHaveBeenCalledTimes(1);
    list.mockResolvedValueOnce(
      ok([job({ id: 'a' }), job({ id: 'b', createdAt: '2026-01-02T00:00:00Z', statusLine: 'Queued' })]),
    );
    fake.emit('jobs', job({ id: 'b', createdAt: '2026-01-02T00:00:00Z', statusLine: 'Queued' }));
    await flush();
    expect(list).toHaveBeenCalledTimes(2);
    expect(lines(host)).toEqual(['Reading sources', 'Queued']);

    // A change for a known job does not refetch.
    fake.emit('jobs', job({ id: 'a', status: 'extracting', statusLine: 'Extracting content' }));
    await flush();
    expect(list).toHaveBeenCalledTimes(2);
    expect(lines(host)).toEqual(['Extracting content', 'Queued']);
  });

  it('a list response that resolves after a newer change event does not roll the line back', async () => {
    const pending = deferred<IpcResult<JobSnapshot[]>>();
    const saving = job({ id: 'a', status: 'saving', statusLine: 'Saving' });
    // The first (startup) list answers late; the refetch after the event answers at once.
    fake.api.jobs.list = vi
      .fn()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue(ok([saving]));
    const host = await render(withAnnouncer(StatusArea), props);
    fake.emit('jobs', saving);
    await flush();
    expect(lines(host)).toEqual(['Saving']);
    await act(async () => pending.resolve(ok([job({ id: 'a', status: 'reading', statusLine: 'Reading sources' })])));
    await flush();
    expect(lines(host)).toEqual(['Saving']);
  });

  it('shows lines from change events even when jobs.list fails', async () => {
    const host = await render(withAnnouncer(StatusArea), props);
    fake.emit('jobs', job({ id: 'a', statusLine: 'Queued', status: 'queued' }));
    await flush();
    expect(lines(host)).toEqual(['Queued']);
  });

  it('disables a line’s actions while one is in flight', async () => {
    fake.api.jobs.list = async () => ok([job({})]);
    const pending = deferred<IpcResult<void>>();
    const cancel = vi.fn(() => pending.promise);
    fake.api.jobs.cancel = cancel;
    const host = await render(withAnnouncer(StatusArea), props);
    await click(button(host, 'Cancel'));
    expect(button(host, 'Cancel')?.disabled).toBe(true);
    await click(button(host, 'Cancel'));
    expect(cancel).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve(ok(undefined)));
    await flush();
    expect(button(host, 'Cancel')?.disabled).toBe(false);
  });

  it('an action on a job main no longer knows removes the line; a conflict shows inline', async () => {
    fake.api.jobs.list = async () => ok([job({ id: 'a' }), job({ id: 'b', createdAt: '2026-01-02T00:00:00Z' })]);
    fake.api.jobs.cancel = async (id: string) =>
      id === 'a' ? fail('E_NOT_FOUND', 'Unknown job') : fail('E_CONFLICT', 'This job is already saving');
    const host = await render(withAnnouncer(StatusArea), props);
    const cancels = () => Array.from(host.querySelectorAll('button')).filter((b) => b.textContent === 'Cancel');
    await click(cancels()[0]);
    expect(host.querySelectorAll('.job-line')).toHaveLength(1);
    await click(cancels()[0]);
    expect(host.querySelector('.job-line .inline-error')?.textContent).toBe('This job is already saving');
  });

  it('a successful retry clears the previous inline error', async () => {
    fake.api.jobs.list = async () =>
      ok([job({ status: 'failed', canCancel: false, canRetry: true, canDismiss: true })]);
    let n = 0;
    fake.api.jobs.retry = async () => (++n === 1 ? fail('E_CONFLICT', 'Not retryable') : ok(undefined));
    const host = await render(withAnnouncer(StatusArea), props);
    await click(button(host, 'Retry'));
    expect(host.textContent).toContain('Not retryable');
    await click(button(host, 'Retry'));
    expect(host.textContent).not.toContain('Not retryable');
  });
});

describe('App against live data (11 §5.2, §8, §13)', () => {
  it('a new document from library:changed slides in at the top without changing the viewer', async () => {
    fake.api.library.list = async () => ok([entry('Topic A', '2026-01-01T00:00:00Z')]);
    const host = await render(App);
    await click(host.querySelector('.library-item'));
    fake.emit('library', {
      entries: [entry('Topic A', '2026-01-01T00:00:00Z'), entry('Topic B', '2026-02-01T00:00:00Z')],
    });
    await flush();
    expect(Array.from(host.querySelectorAll('.item-title')).map((e) => e.textContent)).toEqual(['Topic B', 'Topic A']);
    expect(host.querySelector('[aria-current="page"]')?.textContent).toContain('Topic A');
    expect(host.querySelector('.doc-header h1')?.textContent).toBe('Topic A');
  });

  it('a failed library.open shows the viewer failure state, detaches the viewer, and Retry reopens', async () => {
    fake.api.library.list = async () => ok([entry('Topic A', '2026-01-01T00:00:00Z')]);
    const open = vi.fn(async (): Promise<IpcResult<void>> => fail('E_IO', 'Could not read the document'));
    fake.api.library.open = open;
    const host = await render(App);
    await click(host.querySelector('.library-item'));
    expect(host.textContent).toContain('Could not display this document.');
    expect(host.querySelector('[data-testid="viewer-slot"]')).toBeNull();
    expect(fake.api.viewer.setVisible).toHaveBeenLastCalledWith(false);

    open.mockResolvedValueOnce(ok(undefined));
    await click(button(host, 'Retry'));
    expect(open).toHaveBeenCalledTimes(2);
    expect(host.textContent).not.toContain('Could not display this document.');
    expect(host.querySelector('[data-testid="viewer-slot"]')).not.toBeNull();
    expect(fake.api.viewer.setVisible).toHaveBeenLastCalledWith(true);
  });

  it('library.open E_NOT_FOUND reloads the Library and shows the missing-files state', async () => {
    const list = vi.fn(async () => ok([entry('Topic A', '2026-01-01T00:00:00Z')]));
    fake.api.library.list = list;
    fake.api.library.open = async () => fail('E_NOT_FOUND', 'Not found');
    const host = await render(App);
    list.mockResolvedValue(ok([]));
    await click(host.querySelector('.library-item'));
    await flush();
    expect(list).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain('This document’s files are missing.');
  });

  it('an open result for a document the user already left is ignored', async () => {
    fake.api.library.list = async () =>
      ok([entry('Topic A', '2026-01-01T00:00:00Z'), entry('Topic B', '2026-02-01T00:00:00Z')]);
    const first = deferred<IpcResult<void>>();
    fake.api.library.open = vi.fn((slug: string) =>
      slug === 'topic-a' ? first.promise : Promise.resolve(ok(undefined)),
    );
    const host = await render(App);
    const items = () => Array.from(host.querySelectorAll('.library-item'));
    await click(items()[1]); // Topic A (older, second)
    await click(items()[0]); // Topic B
    await act(async () => first.resolve(fail('E_IO', 'late failure')));
    await flush();
    expect(host.textContent).not.toContain('Could not display this document.');
    expect(host.querySelector('.doc-header h1')?.textContent).toBe('Topic B');
  });

  it('glossary default follows settings until the user touches the toggle', async () => {
    const host = await render(App);
    const toggle = () => host.querySelector<HTMLInputElement>('input[role="switch"]');
    expect(toggle()?.checked).toBe(true);
    const s = settings();
    s.glossary.defaultOn = false;
    fake.emit('settings', { changed: ['glossary.defaultOn'], settings: s });
    await flush();
    expect(toggle()?.checked).toBe(false);
  });

  it('end to end: Enter starts a job, its line appears, and a done line opens the document', async () => {
    fake.api.settings.hasApiKey = async () => ok(true);
    fake.api.library.list = async () => ok([]);
    // A stateful fake main: jobs.list reflects every snapshot it has pushed.
    const known = new Map<string, JobSnapshot>();
    const push = (s: JobSnapshot) => {
      known.set(s.id, s);
      fake.emit('jobs', s);
    };
    fake.api.jobs.list = async () => ok([...known.values()]);
    fake.api.library.open = vi.fn(async () => ok(undefined));
    fake.api.jobs.start = vi.fn(async () => {
      push(job({ id: 'j1', status: 'queued', statusLine: 'Queued' }));
      return ok({ jobId: 'j1' });
    });
    const host = await render(App);
    const url = host.querySelector<HTMLInputElement>('input[aria-label="URL"]');
    await type(url, 'https://example.com/a');
    await key(url, 'Enter');
    expect(host.querySelector('.job-text')?.textContent).toBe('Queued');

    fake.emit('library', { entries: [entry('Topic A', '2026-01-01T00:00:00Z')] });
    push(
      job({
        id: 'j1',
        status: 'done',
        statusLine: 'Done: Topic A',
        result: { docId: 'd', topicSlug: 'topic-a', title: 'Topic A' },
        canCancel: false,
        canDismiss: true,
      }),
    );
    await flush();
    await click(button(host, 'Done: Topic A'));
    expect(fake.api.library.open).toHaveBeenCalledWith('topic-a');
    expect(host.querySelector('[data-testid="viewer-slot"]')).not.toBeNull();
  });
});

describe('ViewerSlot bounds (11 §5.1)', () => {
  it('re-reports bounds when its element resizes (for example when status lines grow)', async () => {
    const observers: ResizeObserverCallback[] = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: ResizeObserverCallback) {
          observers.push(cb);
        }
        observe() {}
        disconnect() {}
      },
    );
    fake.api.library.list = async () => ok([entry('Topic A', '2026-01-01T00:00:00Z')]);
    const host = await render(App);
    await click(host.querySelector('.library-item'));
    const before = vi.mocked(fake.api.viewer.setBounds).mock.calls.length;
    await act(async () => {
      for (const cb of observers) cb([], {} as ResizeObserver);
      await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    });
    expect(vi.mocked(fake.api.viewer.setBounds).mock.calls.length).toBeGreaterThan(before);
    vi.unstubAllGlobals();
  });
});
