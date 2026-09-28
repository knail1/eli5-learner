import { describe, expect, it, vi } from 'vitest';
import type { LibraryMoveReceipt } from '../../../../src/preload/contract';

vi.mock('electron', () => ({ shell: { openExternal: vi.fn() }, app: {}, session: {} }));

const { IPC } = await import('../../../../src/preload/contract');
const { LibraryError } = await import('../../../../src/main/library');
const { invokableChannels } = await import('../../../../src/main/ipc');
const { setup } = await import('./harness');

/** Folders, Archive and Trash channels (09 §4.2, §11; 01 §5.2): app-only, zod-validated. */

const forbidden = { ok: false, error: { code: 'E_FORBIDDEN', message: 'Forbidden' } };

const CALLS: [string, unknown][] = [
  [IPC.library.organization, undefined],
  [IPC.library.createFolder, { name: 'Budgets' }],
  [IPC.library.renameFolder, { folderId: 'f-0123abcd', name: 'Budgets' }],
  [IPC.library.deleteFolder, { folderId: 'f-0123abcd' }],
  [IPC.library.move, { slug: 'solar-power', to: 'archive' }],
  [IPC.library.putBack, { trashId: 'solar-power--20260102T030405' }],
  [IPC.library.deletePermanently, { trashId: 'solar-power--20260102T030405' }],
  [IPC.library.emptyTrash, undefined],
];

describe('eli5:library organization channels (09 §4.2)', () => {
  it('answers the app window and forwards validated arguments', async () => {
    const h = await setup();
    for (const [ch, payload] of CALLS) expect(await h.call(ch, payload)).toMatchObject({ ok: true });
    expect(h.library.createFolder).toHaveBeenCalledWith('Budgets');
    expect(h.library.renameFolder).toHaveBeenCalledWith('f-0123abcd', 'Budgets');
    expect(h.library.deleteFolder).toHaveBeenCalledWith('f-0123abcd');
    expect(h.library.moveDocument).toHaveBeenCalledWith('solar-power', 'archive', { undo: false });
    expect(h.library.putBack).toHaveBeenCalledWith('solar-power--20260102T030405');
    expect(h.library.deletePermanently).toHaveBeenCalledWith('solar-power--20260102T030405');
    expect(h.library.emptyTrash).toHaveBeenCalled();
    expect(await h.call(IPC.library.move, { slug: 'solar-power', to: 'f-0123abcd', undo: true })).toMatchObject({
      ok: true,
      value: { to: 'f-0123abcd', undo: true },
    });
  });

  it('is app-only: the viewer is refused with E_FORBIDDEN and nothing runs', async () => {
    const h = await setup();
    for (const [ch, payload] of CALLS) expect(await h.call(ch, payload, 'viewer')).toEqual(forbidden);
    expect(h.library.moveDocument).not.toHaveBeenCalled();
    expect(h.library.emptyTrash).not.toHaveBeenCalled();
  });

  it('rejects malformed requests before the library sees them', async () => {
    const h = await setup();
    const bad: [string, unknown][] = [
      [IPC.library.createFolder, { name: 'x'.repeat(500) }],
      [IPC.library.createFolder, {}],
      [IPC.library.renameFolder, { folderId: '../x', name: 'A' }],
      [IPC.library.deleteFolder, { folderId: 'archive' }],
      [IPC.library.move, { slug: '../etc', to: 'archive' }],
      [IPC.library.move, { slug: 'solar-power', to: '/tmp' }],
      [IPC.library.move, { slug: 'solar-power', to: 'f-XYZ' }],
      [IPC.library.putBack, { trashId: '../../etc' }],
      [IPC.library.putBack, { trashId: 'solar-power--20260102T030405-premerge' }],
      [IPC.library.deletePermanently, { trashId: 'solar-power' }],
    ];
    for (const [ch, payload] of bad) {
      expect(await h.call(ch, payload), ch).toMatchObject({ ok: false, error: { code: 'E_BAD_REQUEST' } });
    }
    expect(h.library.moveDocument).not.toHaveBeenCalled();
    expect(h.library.putBack).not.toHaveBeenCalled();
  });

  it('maps library refusals to IPC codes with safe messages', async () => {
    const h = await setup();
    h.library.createFolder.mockRejectedValueOnce(new LibraryError('FOLDER_NAME_TAKEN'));
    expect(await h.call(IPC.library.createFolder, { name: 'Budgets' })).toMatchObject({
      ok: false,
      error: { code: 'E_CONFLICT', message: 'A folder with that name already exists' },
    });
    h.library.createFolder.mockRejectedValueOnce(new LibraryError('FOLDER_NAME_INVALID'));
    expect(await h.call(IPC.library.createFolder, { name: 'Trash' })).toMatchObject({
      ok: false,
      error: { code: 'E_BAD_REQUEST' },
    });
    h.library.deleteFolder.mockRejectedValueOnce(new LibraryError('FOLDER_NOT_FOUND'));
    expect(await h.call(IPC.library.deleteFolder, { folderId: 'f-0123abcd' })).toMatchObject({
      ok: false,
      error: { code: 'E_NOT_FOUND', message: 'Folder not found' },
    });
    h.library.putBack.mockRejectedValueOnce(new LibraryError('TRASH_ITEM_NOT_FOUND'));
    expect(await h.call(IPC.library.putBack, { trashId: 'solar-power--20260102T030405' })).toMatchObject({
      ok: false,
      error: { code: 'E_NOT_FOUND', message: 'That document is no longer in the Trash' },
    });
  });

  it('pushes organization and move events to the app renderer only', async () => {
    const h = await setup();
    h.library.emitOrganization();
    await vi.waitFor(() =>
      expect(h.sent).toContainEqual({
        channel: IPC.library.organizationChanged,
        payload: { organization: h.library.org },
      }),
    );
    const r: LibraryMoveReceipt = {
      slug: 'solar-power',
      docId: 'id-solar-power',
      title: 'x',
      from: 'unfiled',
      to: 'archive',
    };
    h.library.emitMoved(r);
    expect(h.sent).toContainEqual({ channel: IPC.library.moved, payload: r });
    // A catalog change can add or remove Trash items (a merge, a trash), so it also refreshes.
    h.sent.length = 0;
    h.library.emit(['solar-power']);
    await vi.waitFor(() => expect(h.sent.map((s) => s.channel)).toContain(IPC.library.organizationChanged));
    expect(h.viewerSent).toEqual([]);
  });

  it('only the newest organization push is sent when two overlap', async () => {
    const h = await setup();
    let release!: () => void;
    h.library.organization.mockImplementationOnce(
      () => new Promise((r) => (release = () => r({ ...h.library.org, trashRetentionDays: 1 }))),
    );
    h.library.emitOrganization();
    h.library.emitOrganization();
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    release();
    await new Promise((r) => setTimeout(r, 0));
    expect(h.sent).toEqual([{ channel: IPC.library.organizationChanged, payload: { organization: h.library.org } }]);
  });

  it('lists the new invokes as invokable and the new events as not', () => {
    const chans = invokableChannels();
    for (const [ch] of CALLS) expect(chans).toContain(ch);
    expect(chans).not.toContain(IPC.library.organizationChanged);
    expect(chans).not.toContain(IPC.library.moved);
  });
});
