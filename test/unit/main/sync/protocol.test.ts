import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  FOLDER_ID_RE as LIBRARY_FOLDER_ID_RE,
  MAX_FOLDER_NAME_CHARS,
  SECTION_ID_PATTERN,
  TAB_KEY_PATTERN,
  VERSION_ID_RE as LIBRARY_VERSION_ID_RE,
  VersionNodeRecordSchema,
} from '../../../../src/main/library';
import { QA_ID_RE, parseDocument } from '../../../../src/main/document';
import { canonicalJson } from '../../../../src/main/document/canonical-json';
import { sectionHash } from '../../../../src/main/document/interactive';
import { MEDIA_TYPES } from '../../../../src/main/sources';
import {
  ANCHOR_ID_RE,
  ATTACHMENT_MIME_TYPES,
  ATTACHMENT_NAME_RE,
  BLANK_RE,
  DEVICE_ID_RE,
  DOC_ID_RE,
  FOLDER_ID_RE,
  HTTP_URL_RE,
  JobRequestSchema,
  LIMITS,
  ONE_LINE_RE,
  SECTION_ID_RE,
  SYNC_SCHEMAS,
  TAB_KEY_RE,
  VERSION_CHANGE_KINDS,
  VERSION_ID_RE,
  VersionTreeSchema,
} from '../../../../src/main/sync/protocol';
import type { SyncFileType } from '../../../../src/main/sync/protocol';
import type { VersionChangeKind } from '../../../../src/preload/contract';
import {
  FIXTURE_DIR,
  LAYOUT_CASES,
  SECTION_HASHES,
  buildSyncContract,
  layoutRemoteTree,
} from '../../../../scripts/export-sync-schema';

const root = resolve(import.meta.dirname, '../../../..');
const fixtureDir = join(root, FIXTURE_DIR);
const readJson = (file: string): unknown => JSON.parse(readFileSync(join(fixtureDir, file), 'utf8'));

interface IndexEntry {
  file: string;
  type: SyncFileType | 'layout';
  valid: boolean;
}
const index = (readJson('index.json') as { fixtures: IndexEntry[] }).fixtures;
const protocolFixtures = index.filter((e): e is IndexEntry & { type: SyncFileType } => e.type !== 'layout');

describe('sync protocol fixtures (16 §12)', () => {
  it('cover every file type with valid and invalid examples', () => {
    for (const type of Object.keys(SYNC_SCHEMAS)) {
      const of = protocolFixtures.filter((e) => e.type === type);
      expect(
        of.some((e) => e.valid),
        `${type} valid`,
      ).toBe(true);
      expect(
        of.some((e) => !e.valid),
        `${type} invalid`,
      ).toBe(true);
    }
  });

  it('lists every file in the folder in index.json', () => {
    const files = readdirSync(fixtureDir).filter((f) => f !== 'index.json');
    expect(index.map((e) => e.file).sort()).toEqual(files.sort());
  });

  it.each(protocolFixtures.filter((e) => e.valid).map((e) => [e.file, e.type] as const))(
    'accepts %s unchanged',
    (file, type) => {
      const raw = readJson(file);
      const r = SYNC_SCHEMAS[type].safeParse(raw);
      expect(r.error?.issues).toBeUndefined();
      // No defaults or transforms: what the desktop parses is exactly what the phone reads.
      expect(r.data).toEqual(raw);
    },
  );

  it.each(protocolFixtures.filter((e) => !e.valid).map((e) => [e.file, e.type] as const))(
    'rejects %s',
    (file, type) => {
      expect(SYNC_SCHEMAS[type].safeParse(readJson(file)).success).toBe(false);
    },
  );
});

describe('version-tree layout fixtures', () => {
  const layouts = index.filter((e) => e.type === 'layout');

  it('has one fixture per layout case', () => {
    expect(layouts.map((e) => e.file).sort()).toEqual(
      Object.keys(LAYOUT_CASES)
        .map((n) => `layout.${n}.json`)
        .sort(),
    );
  });

  it.each(layouts.map((e) => [e.file] as const))('%s matches the desktop layout of a valid tree', (file) => {
    const f = readJson(file) as { tree: unknown; collapsed: string[]; rows: unknown };
    const tree = VersionTreeSchema.parse(f.tree);
    expect(layoutRemoteTree(tree, f.collapsed)).toEqual(f.rows);
  });

  it('shows every node exactly once when nothing is collapsed', () => {
    for (const [name, c] of Object.entries(LAYOUT_CASES)) {
      if (c.collapsed.length > 0) continue;
      const ids = layoutRemoteTree(c.tree, []).map((r) => r.id);
      expect(ids.sort(), name).toEqual(c.tree.nodes.map((n) => n.id).sort());
    }
  });
});

describe('section hashes for phone asks (16 §5.1, 08 §6.3)', () => {
  const contract = JSON.parse(readFileSync(join(root, SECTION_HASHES), 'utf8')) as {
    documents: { file: string; sections: { id: string; hash: string }[] }[];
    canonical: { value: unknown; json: string; hash: string }[];
  };

  it('match the hashes of the parsed documents, so hashing the raw embedded model is enough', () => {
    expect(contract.documents.length).toBeGreaterThan(3);
    for (const d of contract.documents) {
      const html = readFileSync(join(root, 'test/fixtures/documents/build', d.file), 'utf8');
      const parsed = parseDocument(html).model.tabs.flatMap((t) => t.sections);
      expect(
        parsed.map((s) => ({ id: s.id, hash: sectionHash(s) })),
        d.file,
      ).toEqual(d.sections);
    }
  });

  it('cover the canonical JSON edge cases', () => {
    for (const c of contract.canonical) {
      expect(canonicalJson(c.value)).toBe(c.json);
      expect(sectionHash(c.value as never)).toBe(c.hash);
    }
  });
});

describe('generated contract', () => {
  it('matches the files on disk (run npm run gen:sync-schema)', async () => {
    const files = await buildSyncContract(root);
    for (const [rel, content] of files) {
      expect(readFileSync(join(root, rel), 'utf8'), rel).toBe(content);
    }
    const schemas = readdirSync(join(root, 'test/contracts/sync')).filter((f) => f.endsWith('.schema.json'));
    expect(schemas.sort()).toEqual(
      Object.keys(SYNC_SCHEMAS)
        .map((t) => `${t}.schema.json`)
        .sort(),
    );
  });

  it('exports closed objects (no additional properties)', () => {
    const json = JSON.parse(readFileSync(join(root, 'test/contracts/sync/manifest.schema.json'), 'utf8')) as {
      additionalProperties: unknown;
      properties: { docs: { items: { additionalProperties: unknown } } };
    };
    expect(json.additionalProperties).toBe(false);
    expect(json.properties.docs.items.additionalProperties).toBe(false);
  });
});

describe('protocol stays in step with the app', () => {
  it('repeats the library id patterns and limits', () => {
    expect(VERSION_ID_RE.source).toBe(LIBRARY_VERSION_ID_RE.source);
    expect(FOLDER_ID_RE.source).toBe(LIBRARY_FOLDER_ID_RE.source);
    // 16 §4.4 (D21): the protocol keeps the 0.3.0 tab-key pattern on purpose; the app's pattern is
    // the same plus 'ste', which the manifest filters out.
    expect(TAB_KEY_RE.source).toBe('^(indepth|eli5|sx[0-9a-f]{6})$');
    expect(TAB_KEY_PATTERN.source).toBe('^(?:indepth|eli5|ste|sx[0-9a-f]{6})$');
    for (const k of ['indepth', 'eli5', 'sx0a1b2c'])
      expect(TAB_KEY_RE.test(k) && TAB_KEY_PATTERN.test(k), k).toBe(true);
    expect(TAB_KEY_RE.test('ste')).toBe(false);
    expect(SECTION_ID_RE.source).toBe(SECTION_ID_PATTERN.source);
    expect(MAX_FOLDER_NAME_CHARS).toBe(60);
    expect(DOC_ID_RE.test(randomUUID())).toBe(true);
    expect(DEVICE_ID_RE.test(randomUUID())).toBe(true);
  });

  it('accepts Q&A and section ids as a job status anchor', () => {
    expect(ANCHOR_ID_RE.source).toContain(QA_ID_RE.source.slice(1, -1));
    expect(ANCHOR_ID_RE.source).toContain(SECTION_ID_PATTERN.source.slice(1, -1));
    for (const ok of ['q-0a1b2c3d', 'sec-tides-0a1b2c3d']) expect(ANCHOR_ID_RE.test(ok), ok).toBe(true);
    for (const bad of ['', 'top', "x');alert(1)//", 'q-0A1B2C3D']) expect(ANCHOR_ID_RE.test(bad), bad).toBe(false);
  });

  it('lists the version change kinds of the library and the preload contract', () => {
    expect([...VERSION_CHANGE_KINDS].sort()).toEqual([...VersionNodeRecordSchema.shape.kind.options].sort());
    expectTypeOf<(typeof VERSION_CHANGE_KINDS)[number]>().toEqualTypeOf<VersionChangeKind>();
  });

  it('accepts exactly the media types the resolvers sniff (03 §5.2)', () => {
    expect([...ATTACHMENT_MIME_TYPES].sort()).toEqual(Object.values(MEDIA_TYPES).sort());
  });
});

describe('job limits (16 §5.1)', () => {
  const base = {
    v: 1,
    jobId: '019a3c5e-7d2f-7a1b-9c3d-4e5f6a7b8c9d',
    deviceId: '9c8d7e6f-5a4b-4c3d-a2e1-f0e9d8c7b6a5',
    createdAt: '2026-10-01T09:00:00.000Z',
    kind: 'capture',
    urls: [],
    text: 'x',
    clarifyingInput: '',
    focus: [],
    attachments: [],
  };

  it('accepts text and clarifying input at their limits and rejects one more', () => {
    expect(JobRequestSchema.safeParse({ ...base, text: 'x'.repeat(LIMITS.textChars) }).success).toBe(true);
    expect(JobRequestSchema.safeParse({ ...base, text: 'x'.repeat(LIMITS.textChars + 1) }).success).toBe(false);
    const ci = 'x'.repeat(LIMITS.clarifyingInputChars);
    expect(JobRequestSchema.safeParse({ ...base, clarifyingInput: ci }).success).toBe(true);
    expect(JobRequestSchema.safeParse({ ...base, clarifyingInput: `${ci}x` }).success).toBe(false);
  });

  it('accepts exactly 20 http(s) URLs', () => {
    const urls = Array.from({ length: LIMITS.urls }, (_, i) =>
      i % 2 ? `http://example.org/${i}` : `https://a.b/${i}`,
    );
    expect(JobRequestSchema.safeParse({ ...base, urls }).success).toBe(true);
    for (const bad of ['ftp://example.com/a', 'data:text/html,hi', 'https://', 'example.com/a']) {
      expect(JobRequestSchema.safeParse({ ...base, urls: [bad] }).success, bad).toBe(false);
    }
  });

  it('accepts attachments up to 50 MiB per job', () => {
    const att = (c: string, size: number) => ({ sha: c.repeat(64), name: `${c}.pdf`, mime: 'application/pdf', size });
    const ok = [att('a', LIMITS.attachmentBytes), att('b', LIMITS.attachmentBytes), att('c', 10 * 1024 * 1024)];
    expect(JobRequestSchema.safeParse({ ...base, attachments: ok }).success).toBe(true);
    const over = [...ok.slice(0, 2), att('c', 10 * 1024 * 1024 + 1)];
    expect(JobRequestSchema.safeParse({ ...base, attachments: over }).success).toBe(false);
  });

  it('keeps attachment names to a single path segment of at most 200 code points', () => {
    const named = (name: string) => ({
      ...base,
      attachments: [{ sha: 'a'.repeat(64), name, mime: 'application/pdf', size: 1 }],
    });
    for (const ok of [
      'IMG_0001.HEIC',
      'slides deck.pptx',
      '.hidden',
      'ünïcödé.pdf',
      'x'.repeat(200),
      '\u{1F600}'.repeat(200),
    ]) {
      expect(ATTACHMENT_NAME_RE.test(ok), ok).toBe(true);
      expect(JobRequestSchema.safeParse(named(ok)).success, ok).toBe(true);
    }
    const bidi = ['\u202e', '\u202a', '\u2066', '\u2069'].map((c) => `invoice${c}fdp.exe`);
    for (const bad of [
      '',
      '.',
      '..',
      'a/b.pdf',
      'a\\b.pdf',
      'a\u0000b',
      'x'.repeat(201),
      '\u{1F600}'.repeat(201),
      ...bidi,
    ]) {
      expect(JobRequestSchema.safeParse(named(bad)).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('rejects URLs the WHATWG parser would quietly repair, and URLs with credentials', () => {
    for (const bad of [
      'https://exa\tmple.com/',
      ' https://example.com/',
      'https:\\\\example.com/',
      'http:example.com/',
      'https://user:pw@example.com/',
      'https://user@example.com/',
      'https://bücher.example/',
      'https://[::1]/',
      'https://example.com:99999/',
    ]) {
      expect(JobRequestSchema.safeParse({ ...base, urls: [bad] }).success, JSON.stringify(bad)).toBe(false);
    }
    expect(HTTP_URL_RE.test('HTTPS://Example.COM/a%20b?q=1#x')).toBe(true);
  });

  it('counts a capture as empty exactly when String.prototype.trim leaves nothing', () => {
    for (let c = 0; c < 0x10000; c++) {
      const ch = String.fromCharCode(c);
      if (BLANK_RE.test(ch) !== (ch.trim() === '')) expect.fail(`U+${c.toString(16)}`);
    }
    expect(JobRequestSchema.safeParse({ ...base, text: '\ufeff\u00a0 ' }).success).toBe(false);
    expect(JobRequestSchema.safeParse({ ...base, text: '\u001c' }).success).toBe(true);
  });

  it('treats line and paragraph separators as line breaks in a question', () => {
    expect(ONE_LINE_RE.test('Why two tides?')).toBe(true);
    for (const sep of ['\n', '\r', '\u2028', '\u2029']) expect(ONE_LINE_RE.test(`a${sep}b`)).toBe(false);
  });
});
