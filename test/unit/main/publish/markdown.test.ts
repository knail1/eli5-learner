import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULTS } from '../../../../src/main/config/schema';
import type { DocBlockType } from '../../../../src/main/document';
import {
  MarkdownPublisher,
  PublishError,
  blockToMarkdown,
  buildPublishFileSet,
  documentToMarkdown,
  type PublishContext,
} from '../../../../src/main/publish';
import { fixtureDocument, type GoldenName } from '../../../fixtures/documents/models';
import { readGolden } from '../../../fixtures/documents/runtime';

/** Export Markdown (10 §5.2). */

const GOLDEN_DIR = path.join(import.meta.dirname, '../../../fixtures/documents/markdown');
const UPDATE = process.env.ELI5_UPDATE_GOLDENS === '1';
/** Between them, these goldens cover every block type (asserted below). */
const MD_GOLDENS: readonly GoldenName[] = ['full', 'showcase', 'asked'];
const ALL_BLOCKS: readonly DocBlockType[] = [
  'paragraph',
  'list',
  'pullquote',
  'callout',
  'table',
  'chart',
  'diagram',
  'figure',
  'stepper',
  'analogy',
  'qa',
  'explorable',
];

describe('documentToMarkdown (golden)', () => {
  it.each(MD_GOLDENS)('%s matches the committed golden', async (name) => {
    const md = documentToMarkdown(fixtureDocument(name).model);
    const file = path.join(GOLDEN_DIR, `${name}.md`);
    if (UPDATE || !existsSync(file)) {
      await mkdir(GOLDEN_DIR, { recursive: true });
      await writeFile(file, md);
    }
    expect(md).toBe(await readFile(file, 'utf8'));
  });

  it('the goldens cover every block type', () => {
    const seen = new Set<string>();
    for (const name of MD_GOLDENS) {
      for (const tab of fixtureDocument(name).model.tabs) {
        for (const s of tab.sections) for (const b of s.blocks) seen.add(b.type);
      }
    }
    expect([...seen].sort()).toEqual([...ALL_BLOCKS].sort());
  });

  it('title h1, dek paragraph, tabs h2 (placeholder skipped), sections h3, glossary, one sources list', () => {
    const { model } = fixtureDocument('placeholder');
    const md = documentToMarkdown(model);
    expect(md.startsWith(`# ${model.title}\n\n`)).toBe(true);
    for (const t of model.tabs) expect(md.includes(`\n## ${t.label}\n`)).toBe(!t.placeholder);
    expect(md.match(/^## Sources$/gm)).toHaveLength(model.references.length > 0 ? 1 : 0);
    // Reference sections are not rendered inline.
    const refHeadings = model.tabs.flatMap((t) => t.sections.filter((s) => s.kind === 'references'));
    for (const s of refHeadings) expect(md).not.toContain(`### ${s.heading}\n`);
  });
});

describe('blockToMarkdown', () => {
  it('writes an answer box as a quote: the question, then each answer paragraph', () => {
    const md = blockToMarkdown({
      type: 'qa',
      id: 'q-00000001',
      question: 'Is <b>4</b> good?',
      topic: 'Good ROAS',
      quote: 'ROAS of 4',
      paragraphs: ['Yes, **mostly**.', 'Revenue is not profit.'],
      askedAt: '2026-09-27T14:00:00.000Z',
    });
    expect(md).toBe(
      '> **You asked:** Is &lt;b&gt;4&lt;/b&gt; good?\n>\n> Yes, **mostly**.\n>\n> Revenue is not profit.',
    );
  });

  it('escapes literal angle brackets so they stay inert', () => {
    expect(blockToMarkdown({ type: 'paragraph', md: 'Use <script> and a > b' })).toBe(
      'Use &lt;script&gt; and a &gt; b',
    );
  });

  it('tables: cell pipes escaped, line breaks flattened, optional italic caption', () => {
    expect(blockToMarkdown({ type: 'table', caption: 'Plan A', header: ['a|b', 'c'], rows: [['one\ntwo', '3']] })).toBe(
      '| a\\|b | c |\n| --- | --- |\n| one two | 3 |\n\n*Plan A*',
    );
  });

  it('charts: italic title, a data table with missing values as a dash, then highlight and source', () => {
    const md = blockToMarkdown({
      type: 'chart',
      chart: {
        kind: 'bar',
        title: 'Orders',
        xLabel: 'Quarter',
        unit: 'k',
        categories: ['Q1', 'Q2'],
        series: [{ name: 'Online', values: [3, null] }],
        highlight: { category: 'Q1', note: 'Launch' },
        source: 'Sales ledger',
      },
    });
    expect(md).toBe(
      '*Orders*\n\n| Quarter | Online |\n| --- | --- |\n| Q1 | 3 k |\n| Q2 | - |\n\n**Q1:** Launch\n\nSource: Sales ledger',
    );
  });

  it('callouts and analogies are quotes with their prefix; steppers number bold labels', () => {
    expect(blockToMarkdown({ type: 'callout', tone: 'warning', md: 'Mind the gap' })).toBe(
      '> **Warning:** Mind the gap',
    );
    expect(blockToMarkdown({ type: 'analogy', md: 'a relay race' })).toBe('> **Think of it like:** a relay race');
    expect(blockToMarkdown({ type: 'stepper', title: 'How', steps: [{ label: 'Pick', md: 'Choose one' }] })).toBe(
      '**How**\n\n1. **Pick** Choose one',
    );
  });
});

describe('blockToMarkdown: explorables (10 §5.2)', () => {
  const gd = {
    type: 'explorable' as const,
    title: 'Step size',
    caption: 'Try it.',
    alt: 'A bowl.',
    sim: {
      kind: 'gradient-descent' as const,
      surface: 'bowl' as const,
      scale: 1.5,
      start: -4,
      lr: { min: 0.001, max: 2, value: 0.1 },
      steps: 60,
      presets: [1.5],
    },
  };

  it('re-clamps a hand-edited model, so the outcome table stays bounded', () => {
    const md = blockToMarkdown({ ...gd, sim: { ...gd.sim, steps: 1e12 } });
    expect(md).toContain('| 1.5 | diverges | 12 | flew off |');
    const many = blockToMarkdown({ ...gd, sim: { ...gd.sim, presets: [1.5, 1, 0.5, 0.1, 0.01] } });
    expect(many.split('\n').filter((l) => /^\| [0-9]/.test(l))).toHaveLength(3);
  });

  it('keeps only the text when the numbers are unusable', () => {
    const broken = { ...gd, sim: { ...gd.sim, kind: 'eval' } } as unknown as Parameters<typeof blockToMarkdown>[0];
    expect(blockToMarkdown(broken)).toBe('*Step size*\n\nTry it.\n\nA bowl.');
  });
});

describe('MarkdownPublisher', () => {
  let base: string;
  let libraryRoot: string;
  let exportDir: string;
  const slug = 'widget-pricing';

  beforeEach(async () => {
    base = await mkdtemp(path.join(tmpdir(), 'eli5-md-'));
    libraryRoot = path.join(base, 'docs');
    exportDir = path.join(base, 'Export Folder');
    await mkdir(path.join(libraryRoot, slug), { recursive: true });
    await writeFile(path.join(libraryRoot, slug, 'index.html'), readGolden('full'));
  });
  afterEach(() => rm(base, { recursive: true, force: true }));

  async function context(over: Partial<PublishContext> = {}): Promise<PublishContext> {
    const settings = structuredClone(DEFAULTS);
    settings.publish.local.dir = exportDir;
    settings.publish.local.revealAfter = false;
    return {
      slug,
      title: 'Widget pricing',
      files: await buildPublishFileSet(slug, path.join(libraryRoot, slug)),
      settings,
      signal: new AbortController().signal,
      progress: () => {},
      libraryRoot,
      ...over,
    };
  }

  it('describes itself as an always-available local target labelled Export Markdown', async () => {
    const t = await new MarkdownPublisher({ home: base }).describe(slug, (await context()).settings);
    expect(t).toMatchObject({ id: 'markdown', kind: 'local', label: 'Export Markdown', available: true });
  });

  it('writes <export folder>/<slug>/<slug>.md and links to it; the library copy is untouched', async () => {
    const before = await readFile(path.join(libraryRoot, slug, 'index.html'), 'utf8');
    const r = await new MarkdownPublisher({ home: base }).publish(await context());
    const out = path.join(exportDir, slug, `${slug}.md`);
    expect(await readdir(path.join(exportDir, slug))).toEqual([`${slug}.md`]);
    expect(await readFile(out, 'utf8')).toBe(documentToMarkdown(fixtureDocument('full').model));
    expect(r.links).toEqual([{ kind: 'file', url: pathToFileURL(out).href, label: 'Open Markdown', primary: true }]);
    expect(await readFile(path.join(libraryRoot, slug, 'index.html'), 'utf8')).toBe(before);
  });

  it('a cancelled publish writes nothing', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(
      new MarkdownPublisher({ home: base }).publish(await context({ signal: ac.signal })),
    ).rejects.toMatchObject({
      code: 'E_PUBLISH_CANCELLED',
    });
    expect(existsSync(path.join(exportDir, slug))).toBe(false);
  });

  it('a document without an index fails with a clear message', async () => {
    const err = await new MarkdownPublisher({ home: base })
      .publish({ ...(await context()), files: [] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PublishError);
    expect(err).toMatchObject({ code: 'E_PUBLISH_FAILED', message: 'The document has nothing to export' });
  });

  it('refuses an export folder inside the Library', async () => {
    const ctx = await context();
    ctx.settings.publish.local.dir = libraryRoot;
    await expect(new MarkdownPublisher({ home: base }).publish(ctx)).rejects.toMatchObject({
      code: 'E_PUBLISH_DESTINATION',
    });
  });
});
