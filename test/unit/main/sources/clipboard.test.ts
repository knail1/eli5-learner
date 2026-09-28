import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ClipboardResolver,
  clipboardFilePaths,
  looksLikeMarkdown,
  readClipboardInputs,
  type ClipboardPort,
} from '../../../../src/main/sources/clipboard';
import { sha256Text } from '../../../../src/main/sources/io';
import { DEFAULT_RESOLVE_LIMITS, type SourceInput } from '../../../../src/main/sources/types';
import * as fx from './fixtures';
import { fakeCtx } from './helpers';

/** Fake pasteboard (03 §15): named formats plus text/html/image. */
class FakeClipboard implements ClipboardPort {
  constructor(
    private readonly c: {
      formats?: string[];
      named?: Record<string, string>;
      text?: string;
      html?: string;
      image?: Buffer;
    } = {},
  ) {}
  availableFormats(): string[] {
    return this.c.formats ?? [];
  }
  read(format: string): string {
    return this.c.named?.[format] ?? '';
  }
  readText(): string {
    return this.c.text ?? '';
  }
  readHTML(): string {
    return this.c.html ?? '';
  }
  readImage() {
    const img = this.c.image;
    return { isEmpty: () => !img || img.length === 0, toPNG: () => img ?? Buffer.alloc(0) };
  }
  readBuffer(format: string): Buffer {
    return Buffer.from(this.read(format));
  }
}

let seq = 0;
const ids = () => `in-${(++seq).toString(16).padStart(8, '0')}`;

async function route(cb: ClipboardPort) {
  const userData = await fx.tmpDir();
  const inputs = await readClipboardInputs(cb, {
    userData,
    draftId: 'draft-1',
    mintId: ids,
    now: () => new Date('2026-03-04T14:02:00Z'),
  });
  return { userData, inputs };
}

describe('clipboard routing precedence (03 §6.2)', () => {
  it('1. multi-file Finder copy via NSFilenamesPboardType wins over the icon image and name text', async () => {
    const { inputs } = await route(
      new FakeClipboard({
        formats: ['text/plain', 'image/png'],
        named: { NSFilenamesPboardType: fx.FINDER_PLIST },
        text: 'Q3 Review.pptx',
        image: fx.png(),
      }),
    );
    expect(inputs.map((i) => [i.kind, i.origin, i.kind === 'file' ? i.path : ''])).toEqual([
      ['file', 'paste', '/Users/example/Documents/Q3 Review.pptx'],
      ['file', 'paste', '/Users/example/Documents/Notes & Actions.md'],
      ['file', 'paste', '/Users/example/Desktop/café.png'],
    ]);
  });

  it('1.2 public.file-url is the single-file fallback; relative plist entries are dropped', async () => {
    const cb = new FakeClipboard({
      named: {
        NSFilenamesPboardType: '<plist><array><string>relative/a.txt</string></array></plist>',
        'public.file-url': 'file:///Users/example/Documents/Plan%20B.docx',
      },
    });
    expect(clipboardFilePaths(cb)).toEqual(['/Users/example/Documents/Plan B.docx']);
  });

  it('1. malformed plist is treated as empty and routing continues', async () => {
    const { inputs } = await route(
      new FakeClipboard({ named: { NSFilenamesPboardType: '<plist><oops' }, text: 'hello' }),
    );
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.kind).toBe('text');
  });

  it('2.1 text where every non-empty line is an http(s) URL -> one url input per line', async () => {
    const { inputs } = await route(
      new FakeClipboard({ text: '  https://example.com/a \n\nhttp://example.org/b\n', image: fx.png() }),
    );
    expect(inputs).toEqual([
      { id: expect.any(String), kind: 'url', origin: 'paste', url: 'https://example.com/a' },
      { id: expect.any(String), kind: 'url', origin: 'paste', url: 'http://example.org/b' },
    ]);
  });

  it('2.2 rich text (text/html available) is staged as HTML; the picture is ignored', async () => {
    const html = '<table><tr><td>Region</td><td>Revenue</td></tr></table>';
    const { inputs, userData } = await route(
      new FakeClipboard({
        formats: ['text/plain', 'text/html', 'image/png'],
        text: 'Region\tRevenue',
        html,
        image: fx.png(),
      }),
    );
    expect(inputs).toHaveLength(1);
    const t = inputs[0] as Extract<SourceInput, { kind: 'text' }>;
    expect(t).toMatchObject({ kind: 'text', origin: 'paste', markup: 'html', preview: 'Pasted text: Region Revenue' });
    expect(t.stagedPath.startsWith(path.join(userData, 'staging', 'drafts', 'draft-1'))).toBe(true);
    expect(path.basename(t.stagedPath)).toBe('pasted-1.html');
    expect(await readFile(t.stagedPath, 'utf8')).toBe(html);
  });

  it('2.3 plain text is staged as .txt when no HTML is available', async () => {
    const text = 'Example Widgets Inc. meeting notes that go on for more than forty characters';
    const { inputs } = await route(new FakeClipboard({ formats: ['text/plain'], text, html: '<p>ignored</p>' }));
    const t = inputs[0] as Extract<SourceInput, { kind: 'text' }>;
    expect(t.markup).toBe('plain');
    expect(t.preview).toBe(`Pasted text: ${text.slice(0, 40)}…`);
    expect(await readFile(t.stagedPath, 'utf8')).toBe(text);
  });

  it('3. whitespace-only text falls through to the image branch (screenshot -> png)', async () => {
    const { inputs } = await route(new FakeClipboard({ formats: ['image/png'], text: '  \n ', image: fx.png() }));
    const img = inputs[0] as Extract<SourceInput, { kind: 'image' }>;
    expect(img).toMatchObject({ kind: 'image', mediaType: 'image/png', preview: 'Pasted image 14:02' });
    expect(await readFile(img.stagedPath)).toEqual(fx.png());
  });

  it('4. nothing usable -> []', async () => {
    expect((await route(new FakeClipboard({ formats: ['text/rtf'] }))).inputs).toEqual([]);
  });
});

describe('looksLikeMarkdown', () => {
  it('needs at least two heading or list lines', () => {
    expect(looksLikeMarkdown('# Title\n\nPara\n- item')).toBe(true);
    expect(looksLikeMarkdown('1. one\n2) two')).toBe(true);
    expect(looksLikeMarkdown('# Title only\nplain')).toBe(false);
    expect(looksLikeMarkdown('#hashtag\n-dash')).toBe(false);
  });
});

describe('ClipboardResolver (03 §6.4)', () => {
  const r = new ClipboardResolver();

  async function staged(name: string, data: Buffer | string) {
    const stagingDir = await fx.tmpDir();
    const p = await fx.put(stagingDir, `inputs/${name}`, data);
    return { stagingDir, p };
  }
  const textIn = (p: string, markup: 'plain' | 'html' = 'plain'): SourceInput => ({
    id: 'in-0000c0de',
    kind: 'text',
    origin: 'paste',
    stagedPath: p,
    markup,
    preview: 'Pasted text: Example…',
  });
  const imageIn = (p: string): SourceInput => ({
    id: 'in-0000beef',
    kind: 'image',
    origin: 'paste',
    stagedPath: p,
    mediaType: 'image/png',
    preview: 'Pasted image 14:02',
  });

  it('has the spec shape', () => {
    expect([r.id, r.lane, r.handles]).toEqual(['clipboard', 'local', ['text', 'image']]);
    expect(r.canResolve(textIn('/x'), fakeCtx())).toBe(true);
    expect(r.canResolve({ id: 'in-1', kind: 'url', origin: 'paste', url: 'https://e.test' }, fakeCtx())).toBe(false);
  });

  it('plain text -> text payload; two heading/list lines -> markdown', async () => {
    const { stagingDir, p } = await staged('0-pasted-1.txt', fx.TEXT_BODY);
    const out = await r.resolve(textIn(p), fakeCtx({ stagingDir }));
    expect(out.resolved[0]).toEqual({
      id: '',
      inputId: 'in-0000c0de',
      ref: 'Pasted text: Example…',
      location: 'clipboard',
      lane: 'local',
      resolverId: 'clipboard',
      format: 'text',
      mediaType: 'text/plain',
      payload: { kind: 'text', text: fx.TEXT_BODY },
      sizeBytes: Buffer.byteLength(fx.TEXT_BODY),
      sha256: sha256Text(fx.TEXT_BODY),
      notes: [],
    });
    const md = await staged('1-pasted-2.txt', '# Plan\n- one\n- two\n');
    expect((await r.resolve(textIn(md.p), fakeCtx({ stagingDir: md.stagingDir }))).resolved[0]?.format).toBe(
      'markdown',
    );
  });

  it('html -> html payload without baseUrl', async () => {
    const { stagingDir, p } = await staged('0-pasted-1.html', '<h1>Hi</h1>');
    const out = await r.resolve(textIn(p, 'html'), fakeCtx({ stagingDir }));
    expect(out.resolved[0]).toMatchObject({ format: 'html', payload: { kind: 'html', html: '<h1>Hi</h1>' } });
    expect(out.resolved[0]?.payload).not.toHaveProperty('baseUrl');
  });

  it('image -> png path payload after verifying the PNG signature', async () => {
    const { stagingDir, p } = await staged('0-pasted-1.png', fx.png());
    const out = await r.resolve(imageIn(p), fakeCtx({ stagingDir }));
    expect(out.resolved[0]).toMatchObject({
      format: 'png',
      mediaType: 'image/png',
      payload: { kind: 'path', path: p },
      ref: 'Pasted image 14:02',
    });
    const bad = await staged('0-pasted-1.png', fx.jpeg());
    expect((await r.resolve(imageIn(bad.p), fakeCtx({ stagingDir: bad.stagingDir }))).skipped[0]?.code).toBe(
      'unsupported-type',
    );
  });

  it('limits: text over maxFileBytes and images over maxImageBytes -> too-large', async () => {
    const limits = { ...DEFAULT_RESOLVE_LIMITS, maxFileBytes: 10, maxImageBytes: 10 };
    const t = await staged('0-pasted-1.txt', 'x'.repeat(50));
    expect((await r.resolve(textIn(t.p), fakeCtx({ stagingDir: t.stagingDir, limits }))).skipped[0]?.code).toBe(
      'too-large',
    );
    const i = await staged('0-pasted-1.png', fx.png());
    expect((await r.resolve(imageIn(i.p), fakeCtx({ stagingDir: i.stagingDir, limits }))).skipped[0]?.code).toBe(
      'too-large',
    );
  });

  it('missing snapshot -> not-found "Pasted item was no longer available."', async () => {
    const stagingDir = await fx.tmpDir();
    const out = await r.resolve(textIn(path.join(stagingDir, 'inputs', 'gone.txt')), fakeCtx({ stagingDir }));
    expect(out.skipped).toEqual([
      { ref: 'Pasted text: Example…', code: 'not-found', reason: 'Pasted item was no longer available.' },
    ]);
  });

  it('a stagedPath outside <stagingDir>/inputs/ is a read-error and is never read', async () => {
    const stagingDir = await fx.tmpDir();
    const draft = await fx.put(stagingDir, 'staging/drafts/d1/in-1/pasted-1.txt', 'secret-ish');
    for (const p of [draft, path.join(stagingDir, 'inputs', '..', 'x.txt'), 'relative/inputs/a.txt']) {
      expect((await r.resolve(textIn(p), fakeCtx({ stagingDir }))).skipped[0]?.code).toBe('read-error');
    }
  });

  it('whitespace-only staged text -> empty', async () => {
    const { stagingDir, p } = await staged('0-pasted-1.txt', ' \n\t');
    expect((await r.resolve(textIn(p), fakeCtx({ stagingDir }))).skipped[0]?.code).toBe('empty');
  });
});
