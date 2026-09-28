import { describe, expect, it } from 'vitest';
import { snapshotClipboard, type AsyncClipboard } from '../../../../src/main/ipc/clipboard';

/** Electron 44's async clipboard (W3C shape) adapted to 03's synchronous ClipboardPort. */

const OS = (f: string) => `electron application/osclipboard;format="${f}"`;

function fakeClipboard(data: Record<string, string | Uint8Array>, text = ''): AsyncClipboard {
  const item = {
    types: Object.keys(data).filter((t) => !t.startsWith('electron ')),
    getType: (t: string) => {
      const v = data[t];
      if (v === undefined) return Promise.reject(new Error('missing'));
      return Promise.resolve(new Blob([v as BlobPart]));
    },
  };
  return {
    read: () => Promise.resolve([item]),
    readText: () => Promise.resolve(text),
    has: (m: string) => Promise.resolve(m in data),
  };
}

describe('snapshotClipboard', () => {
  it('exposes text, html and formats', async () => {
    const p = await snapshotClipboard(fakeClipboard({ 'text/plain': 'hello', 'text/html': '<b>hello</b>' }));
    expect(p.availableFormats()).toEqual(['text/plain', 'text/html']);
    expect(p.readText()).toBe('hello');
    expect(p.readHTML()).toBe('<b>hello</b>');
    expect(p.readImage().isEmpty()).toBe(true);
  });

  it('falls back to readText when no text/plain item exists', async () => {
    const p = await snapshotClipboard(fakeClipboard({}, 'plain words'));
    expect(p.readText()).toBe('plain words');
  });

  it('exposes a PNG image', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const p = await snapshotClipboard(fakeClipboard({ 'image/png': png }));
    expect(p.readImage().isEmpty()).toBe(false);
    expect([...p.readImage().toPNG()]).toEqual([...png]);
  });

  it('reads Finder file references through the raw OS formats', async () => {
    const plist = '<plist><array><string>/Users/me/a.pdf</string></array></plist>';
    const p = await snapshotClipboard(
      fakeClipboard({ [OS('NSFilenamesPboardType')]: plist, [OS('public.file-url')]: 'file:///Users/me/a.pdf' }),
    );
    expect(p.read('NSFilenamesPboardType')).toBe(plist);
    expect(p.read('public.file-url')).toBe('file:///Users/me/a.pdf');
    expect(p.read('other')).toBe('');
  });

  it('returns an empty snapshot when the clipboard cannot be read', async () => {
    const broken: AsyncClipboard = {
      read: () => Promise.reject(new Error('denied')),
      readText: () => Promise.reject(new Error('denied')),
      has: () => Promise.reject(new Error('denied')),
    };
    const p = await snapshotClipboard(broken);
    expect(p.availableFormats()).toEqual([]);
    expect(p.readText()).toBe('');
    expect(p.read('NSFilenamesPboardType')).toBe('');
  });
});
