import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ shell: { openExternal: vi.fn() }, app: {}, session: {} }));

const { IPC } = await import('../../../../src/preload/contract');
const { PipelineRequestError } = await import('../../../../src/main/pipeline');
const { LibraryError } = await import('../../../../src/main/library');
const { setup, snapshot, entry } = await import('./harness');

const opts = { clarifyingInput: '', glossary: true };
const forbidden = { ok: false, error: { code: 'E_FORBIDDEN', message: 'Forbidden' } };
const url = (u: string, id = 'in-00000001') => ({ id, kind: 'url', origin: 'url-field', url: u });
const file = (p: string, id = 'in-00000002') => ({ id, kind: 'file', origin: 'drop', path: p });
const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

describe('eli5:jobs:* (06 §11)', () => {
  it('starts a URL job and returns its id', async () => {
    const h = await setup();
    const r = await h.call(IPC.jobs.start, { inputs: [url('https://example.com/a')], options: opts });
    expect(r).toEqual({ ok: true, value: { jobId: 'job-1' } });
    expect(h.jobs.started[0]?.inputs).toEqual([url('https://example.com/a')]);
  });

  it('rejects zero sources with E_BAD_REQUEST before any other check', async () => {
    const h = await setup();
    h.keyReady.value = false;
    const r = await h.call(IPC.jobs.start, { inputs: [], options: opts });
    expect(r).toEqual({ ok: false, error: { code: 'E_BAD_REQUEST', message: 'Add at least one source' } });
    expect(h.jobs.started).toHaveLength(0);
  });

  it('returns E_NO_API_KEY without creating a job when no key is stored (01 §6.2)', async () => {
    const h = await setup();
    h.keyReady.value = false;
    const r = await h.call(IPC.jobs.start, { inputs: [url('https://example.com/a')], options: opts });
    expect(r).toEqual({ ok: false, error: { code: 'E_NO_API_KEY', message: 'Add an API key in Settings' } });
    expect(h.jobs.started).toHaveLength(0);
  });

  it('rejects malformed requests with E_BAD_REQUEST', async () => {
    const h = await setup();
    for (const bad of [
      undefined,
      { inputs: [url('https://example.com')] },
      { inputs: [{ id: 'in-1', kind: 'mcp', origin: 'drop' }], options: opts },
      { inputs: [url('https://example.com', 'BAD ID')], options: opts },
      { inputs: [url('https://example.com')], options: { clarifyingInput: 'x'.repeat(20_000), glossary: true } },
      { inputs: [url('https://example.com')], options: opts, draftId: '../escape' },
    ]) {
      expect(await h.call(IPC.jobs.start, bad)).toMatchObject({ ok: false, error: { code: 'E_BAD_REQUEST' } });
    }
    expect(h.jobs.started).toHaveLength(0);
  });

  it('rejects a raw file path that is not a registered drop id (E_FORBIDDEN)', async () => {
    const h = await setup();
    const r = await h.call(IPC.jobs.start, { inputs: [file('/etc/hosts')], options: opts });
    expect(r).toMatchObject({ ok: false, error: { code: 'E_FORBIDDEN' } });
    // A path that was dropped is still refused unless the input carries main's id for it.
    await h.call(IPC.sources.registerDrop, { paths: ['/etc/hosts'] });
    expect(await h.call(IPC.jobs.start, { inputs: [file('/etc/hosts')], options: opts })).toMatchObject({
      ok: false,
      error: { code: 'E_FORBIDDEN' },
    });
    expect(h.jobs.started).toHaveLength(0);
  });

  it("register-drop returns opaque ids; jobs:start maps them back to main's path (06 §11)", async () => {
    const h = await setup();
    const p = path.join(h.userData, 'deck.pptx');
    const reg = await h.call<{ inputId: string; path: string }[]>(IPC.sources.registerDrop, { paths: [p] });
    expect(reg).toMatchObject({ ok: true, value: [{ path: p }] });
    const inputId = reg.ok ? reg.value[0]!.inputId : '';
    expect(inputId).toMatch(/^[a-z0-9-]{1,64}$/);
    // The renderer-supplied path and snapshot are ignored; main's registered path is used.
    const forged = { ...file('/etc/passwd', inputId), snapshot: { copyPath: '/etc/passwd', sizeBytes: 1, mtimeMs: 1 } };
    const r = await h.call(IPC.jobs.start, { inputs: [forged], options: opts });
    expect(r).toEqual({ ok: true, value: { jobId: 'job-1' } });
    expect(h.jobs.started[0]?.inputs[0]).toEqual(file(p, inputId));
    // A registration is consumed by a successful start.
    expect(await h.call(IPC.jobs.start, { inputs: [file(p, inputId)], options: opts })).toMatchObject({
      ok: false,
      error: { code: 'E_FORBIDDEN' },
    });
  });

  it('keeps a registration when the start fails, so the draft can be retried', async () => {
    const h = await setup();
    const p = path.join(h.userData, 'deck.pptx');
    const reg = await h.call<{ inputId: string }[]>(IPC.sources.registerDrop, { paths: [p] });
    const inputId = reg.ok ? reg.value[0]!.inputId : '';
    h.keyReady.value = false;
    expect(await h.call(IPC.jobs.start, { inputs: [file(p, inputId)], options: opts })).toMatchObject({
      ok: false,
      error: { code: 'E_NO_API_KEY' },
    });
    h.keyReady.value = true;
    expect(await h.call(IPC.jobs.start, { inputs: [file(p, inputId)], options: opts })).toMatchObject({ ok: true });
  });

  it('rejects register-drop with relative paths', async () => {
    const h = await setup();
    expect(await h.call(IPC.sources.registerDrop, { paths: ['relative/deck.pptx'] })).toMatchObject({
      ok: false,
      error: { code: 'E_BAD_REQUEST' },
    });
  });

  it('accepts file inputs that came from a clipboard read, by their main-minted id (03 §6.2 step 1)', async () => {
    const h = await setup();
    const p = path.join(h.userData, 'notes.md');
    h.clipboard.data['public.file-url'] = `file://${p}`;
    const r = await h.call<{ id: string; kind: string; path: string }[]>(IPC.sources.readClipboard, {
      draftId: 'draft-0001',
    });
    expect(r.ok && r.value[0]).toMatchObject({ kind: 'file', origin: 'paste', path: p });
    const input = r.ok ? r.value[0]! : undefined;
    expect(await h.call(IPC.jobs.start, { inputs: [{ ...input, path: '/etc/passwd' }], options: opts })).toMatchObject({
      ok: true,
    });
    expect(h.jobs.started[0]?.inputs[0]).toMatchObject({ path: p });
  });

  it('accepts staged text only from the request draft and the chip id (03 §13)', async () => {
    const h = await setup();
    const staged = await h.call<{ id: string; stagedPath: string }>(IPC.sources.stageText, {
      draftId: 'draft-0001',
      text: 'hello there',
      markup: 'plain',
    });
    expect(staged).toMatchObject({ ok: true, value: { kind: 'text', origin: 'paste', markup: 'plain' } });
    const input = staged.ok ? staged.value : undefined;
    // Missing draftId, another draft, or a path outside the chip folder are all forbidden.
    expect(await h.call(IPC.jobs.start, { inputs: [input], options: opts })).toMatchObject({
      ok: false,
      error: { code: 'E_FORBIDDEN' },
    });
    expect(await h.call(IPC.jobs.start, { inputs: [input], options: opts, draftId: 'draft-0002' })).toMatchObject({
      ok: false,
      error: { code: 'E_FORBIDDEN' },
    });
    const escaped = { ...input, stagedPath: path.join(h.userData, 'staging', 'drafts', 'draft-0001', '..', 'x.txt') };
    expect(await h.call(IPC.jobs.start, { inputs: [escaped], options: opts, draftId: 'draft-0001' })).toMatchObject({
      ok: false,
      error: { code: 'E_FORBIDDEN' },
    });
    expect(await h.call(IPC.jobs.start, { inputs: [input], options: opts, draftId: 'draft-0001' })).toMatchObject({
      ok: true,
    });
  });

  it('lists snapshots and routes cancel, retry and dismiss', async () => {
    const h = await setup();
    h.jobs.snapshots = [snapshot('job-1')];
    expect(await h.call(IPC.jobs.list)).toEqual({ ok: true, value: [snapshot('job-1')] });
    expect(await h.call(IPC.jobs.cancel, { jobId: 'job-1' })).toEqual({ ok: true, value: undefined });
    expect(await h.call(IPC.jobs.retry, { jobId: 'job-1' })).toEqual({ ok: true, value: undefined });
    expect(await h.call(IPC.jobs.dismiss, { jobId: 'job-1' })).toEqual({ ok: true, value: undefined });
    expect(h.jobs.cancel).toHaveBeenCalledWith('job-1');
    expect(h.jobs.retry).toHaveBeenCalledWith('job-1');
    expect(h.jobs.dismiss).toHaveBeenCalledWith('job-1');
    expect(await h.call(IPC.jobs.cancel, { jobId: '../x' })).toMatchObject({
      ok: false,
      error: { code: 'E_BAD_REQUEST' },
    });
  });

  it('maps pipeline request errors to their IpcErrorCode', async () => {
    const h = await setup();
    h.jobs.cancel.mockRejectedValueOnce(new PipelineRequestError('E_NOT_FOUND', 'No such job'));
    h.jobs.retry.mockRejectedValueOnce(new PipelineRequestError('E_CONFLICT', 'This job cannot be retried'));
    h.jobs.startImpl = () =>
      Promise.reject(new PipelineRequestError('E_LIBRARY_READ_ONLY', 'The Library is read-only'));
    expect(await h.call(IPC.jobs.cancel, { jobId: 'nope' })).toEqual({
      ok: false,
      error: { code: 'E_NOT_FOUND', message: 'No such job' },
    });
    expect(await h.call(IPC.jobs.retry, { jobId: 'job-1' })).toEqual({
      ok: false,
      error: { code: 'E_CONFLICT', message: 'This job cannot be retried' },
    });
    expect(await h.call(IPC.jobs.start, { inputs: [url('https://example.com')], options: opts })).toEqual({
      ok: false,
      error: { code: 'E_LIBRARY_READ_ONLY', message: 'The Library is read-only' },
    });
  });

  it('pushes every job change to the app renderer and stops after dispose', async () => {
    const h = await setup();
    h.jobs.emit(snapshot('job-9', 'reading'));
    expect(h.sent).toEqual([{ channel: IPC.jobs.changed, payload: snapshot('job-9', 'reading') }]);
    h.dispose();
    expect(h.jobs.listenerCount()).toBe(0);
  });

  it('rejects jobs channels from the viewer', async () => {
    const h = await setup();
    expect(await h.call(IPC.jobs.list, undefined, 'viewer')).toEqual(forbidden);
    expect(await h.call(IPC.sources.registerDrop, { paths: ['/x'] }, 'viewer')).toEqual(forbidden);
  });
});

describe('eli5:sources:* (03 §13)', () => {
  it('stages text under the draft and discards one chip, then the whole draft', async () => {
    const h = await setup();
    const r = await h.call<{ id: string; stagedPath: string }>(IPC.sources.stageText, {
      draftId: 'draft-0001',
      text: '<p>Hi</p>',
      markup: 'html',
    });
    if (!r.ok) throw new Error('stage failed');
    expect(r.value.stagedPath.startsWith(path.join(h.userData, 'staging', 'drafts', 'draft-0001'))).toBe(true);
    expect(await readFile(r.value.stagedPath, 'utf8')).toBe('<p>Hi</p>');
    expect(await h.call(IPC.sources.discard, { draftId: 'draft-0001', inputId: r.value.id })).toEqual({
      ok: true,
      value: undefined,
    });
    expect(await exists(r.value.stagedPath)).toBe(false);
    const dir = path.join(h.userData, 'staging', 'drafts', 'draft-0001');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'x'), '');
    expect(await h.call(IPC.sources.discardDraft, { draftId: 'draft-0001' })).toMatchObject({ ok: true });
    expect(await exists(dir)).toBe(false);
  });

  it('reads the clipboard into inputs and returns [] when nothing is usable', async () => {
    const h = await setup();
    expect(await h.call(IPC.sources.readClipboard, { draftId: 'draft-0001' })).toEqual({ ok: true, value: [] });
    h.clipboard.text = 'https://example.com/a\nhttps://example.com/b';
    const r = await h.call<unknown[]>(IPC.sources.readClipboard, { draftId: 'draft-0001' });
    expect(r.ok && r.value).toHaveLength(2);
  });

  it('validates draft and input ids against ^[a-z0-9-]{1,64}$', async () => {
    const h = await setup();
    for (const [ch, p] of [
      [IPC.sources.readClipboard, { draftId: '../x' }],
      [IPC.sources.stageText, { draftId: 'Draft', text: 'x', markup: 'plain' }],
      [IPC.sources.stageText, { draftId: 'draft-1', text: 'x', markup: 'rtf' }],
      [IPC.sources.discard, { draftId: 'draft-1', inputId: 'a/b' }],
      [IPC.sources.discardDraft, { draftId: 'x'.repeat(65) }],
    ] as const) {
      expect(await h.call(ch, p)).toMatchObject({ ok: false, error: { code: 'E_BAD_REQUEST' } });
    }
  });
});

describe('eli5:library:* (09 §11)', () => {
  it('lists the catalog and reports library info', async () => {
    const h = await setup();
    expect(await h.call(IPC.library.list)).toEqual({ ok: true, value: [entry('solar-power'), entry('tax-basics')] });
    expect(await h.call(IPC.library.info)).toEqual({
      ok: true,
      value: { root: '/tmp/lib', readOnly: false, count: 2 },
    });
  });

  it('opens and reveals catalogued documents only', async () => {
    const h = await setup();
    expect(await h.call(IPC.library.open, { slug: 'solar-power' })).toEqual({ ok: true, value: undefined });
    expect(await h.call(IPC.library.reveal, { slug: 'tax-basics' })).toEqual({ ok: true, value: undefined });
    expect(h.opened).toEqual(['solar-power']);
    expect(h.revealed).toEqual(['tax-basics']);
    expect(await h.call(IPC.library.open, { slug: 'missing-doc' })).toEqual({
      ok: false,
      error: { code: 'E_NOT_FOUND', message: 'Document not found' },
    });
    expect(await h.call(IPC.library.reveal, { slug: '../etc' })).toMatchObject({
      ok: false,
      error: { code: 'E_BAD_REQUEST' },
    });
    expect(h.opened).toEqual(['solar-power']);
  });

  it('pushes the full catalog on every library change', async () => {
    const h = await setup();
    h.library.entries = [entry('new-doc')];
    h.library.emit(['new-doc']);
    expect(h.sent).toEqual([{ channel: IPC.library.changed, payload: { entries: [entry('new-doc')] } }]);
  });

  it('maps LibraryError codes at the boundary (01 §5.1)', async () => {
    const { toIpcError } = await import('../../../../src/main/ipc');
    expect(toIpcError(new LibraryError('LIBRARY_READ_ONLY'))).toMatchObject({ code: 'E_LIBRARY_READ_ONLY' });
    expect(toIpcError(new LibraryError('NOT_FOUND'))).toMatchObject({ code: 'E_NOT_FOUND' });
    expect(toIpcError(new LibraryError('SUGGESTION_STALE'))).toMatchObject({ code: 'E_SUGGESTION_STALE' });
    expect(toIpcError(new LibraryError('MERGE_FAILED'))).toMatchObject({ code: 'E_MERGE_FAILED' });
    expect(toIpcError(new LibraryError('WRITE_FAILED', { path: '/secret' }))).toEqual({
      code: 'E_IO',
      message: 'Could not access the Library',
    });
  });

  it('rejects library channels from the viewer', async () => {
    const h = await setup();
    expect(await h.call(IPC.library.open, { slug: 'solar-power' }, 'viewer')).toEqual(forbidden);
    expect(h.opened).toEqual([]);
  });
});

describe('M3 channels stay registered as not implemented', () => {
  it('answers suggestions, publish and doc section channels with E_INTERNAL', async () => {
    const h = await setup();
    for (const ch of [IPC.suggestions.list, IPC.publish.targets]) {
      expect(await h.call(ch, {})).toEqual({
        ok: false,
        error: { code: 'E_INTERNAL', message: 'Not implemented yet' },
      });
    }
    expect(await h.call(IPC.doc.regenerateSection, {}, 'viewer')).toEqual({
      ok: false,
      error: { code: 'E_INTERNAL', message: 'Not implemented yet' },
    });
  });
});

describe('docUrl', () => {
  it('builds the eli5doc URL for a slug and loads it into the viewer', async () => {
    const { docUrl, openInViewer } = await import('../../../../src/main/ipc');
    expect(docUrl('solar-power')).toBe('eli5doc://doc/solar-power/index.html');
    const loadURL = vi.fn(() => Promise.reject(new Error('ERR_ABORTED')));
    openInViewer({ loadURL } as never, 'solar-power');
    expect(loadURL).toHaveBeenCalledWith('eli5doc://doc/solar-power/index.html');
    expect(() => openInViewer(undefined, 'solar-power')).not.toThrow();
    expect(() => docUrl('../x')).toThrow();
    // Tray and context-menu callers pass catalogue slugs unchecked: an invalid one never loads or throws.
    loadURL.mockClear();
    expect(() => openInViewer({ loadURL } as never, '../x')).not.toThrow();
    expect(loadURL).not.toHaveBeenCalled();
  });
});
