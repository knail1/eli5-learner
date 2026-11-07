import { describe, expect, it } from 'vitest';
import { IPC, VIEWER_CHANNELS, type IpcChannel } from '../../../src/preload/contract';

/** The IPC channel registry (01 §5.2) and which channels the document viewer may invoke (01 §5.1). */

const all: IpcChannel[] = Object.values(IPC).flatMap((group) => Object.values(group) as IpcChannel[]);

describe('IPC channel registry (01 §5.2)', () => {
  it('names every channel eli5:<area>:<name>, with no channel listed twice', () => {
    for (const c of all) expect(c).toMatch(/^eli5:[a-z]+:[a-z0-9-]+$/);
    expect(new Set(all).size).toBe(all.length);
  });

  it('puts each channel under its own area key', () => {
    for (const [area, group] of Object.entries(IPC)) {
      for (const c of Object.values(group)) expect(c.split(':')[1]).toBe(area);
    }
  });

  it('has the Ask and version tree channels (08 §6.8, 09 §4.1)', () => {
    expect(IPC.doc.askSection).toBe('eli5:doc:ask-section');
    expect(IPC.doc.versions).toBe('eli5:doc:versions');
    expect(IPC.doc.checkout).toBe('eli5:doc:checkout');
    expect(IPC.doc.versionsChanged).toBe('eli5:doc:versions-changed');
  });
});

describe('VIEWER_CHANNELS (01 §5.1)', () => {
  it('lists exactly the section actions, Ask and open-external', () => {
    expect([...VIEWER_CHANNELS].sort()).toEqual(
      [
        IPC.doc.regenerateSection,
        IPC.doc.createSectionEli5,
        IPC.doc.closeTab,
        IPC.doc.askSection,
        IPC.viewer.openExternal,
      ].sort(),
    );
  });

  it('keeps history, versions and checkout app-only', () => {
    for (const c of [IPC.doc.history, IPC.doc.undo, IPC.doc.redo, IPC.doc.versions, IPC.doc.checkout]) {
      expect(VIEWER_CHANNELS).not.toContain(c);
    }
  });

  it('only lists registered channels, once each', () => {
    for (const c of VIEWER_CHANNELS) expect(all).toContain(c);
    expect(new Set(VIEWER_CHANNELS).size).toBe(VIEWER_CHANNELS.length);
  });
});
