import { createHash, randomBytes } from 'node:crypto';
import { mkdir as fsMkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Settings } from '../config';
import { parseDocument, type DocBlock, type DocumentModel, type ReferenceEntry } from '../document';
import { abbreviateHome, cancelled, expandHome, prepareExportDir, writeExportFile } from './local';
import { PublishError } from './types';
import type { PublishContext, Publisher, PublishResult, PublishTarget } from './types';

// ---------------------------------------------------------------------------
// Document model -> Markdown (10 §5.2)
// ---------------------------------------------------------------------------

/** Literal angle brackets are escaped so they stay inert in any Markdown renderer. */
const esc = (s: string): string => s.replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** One line: line breaks flattened to spaces. */
const oneLine = (s: string): string =>
  esc(s)
    .replace(/\s*\r?\n\s*/g, ' ')
    .trim();
/** Text inside `*...*`: its own asterisks are escaped so the italics stay balanced. */
const italic = (s: string): string => `*${oneLine(s).replace(/\*/g, '\\*')}*`;
/** A pipe-table cell: pipes escaped, line breaks flattened. */
const cell = (s: string): string => oneLine(s).replace(/\|/g, '\\|');
/** Each line of `s` as a blockquote line. */
const quote = (s: string): string =>
  esc(s)
    .split(/\r?\n/)
    .map((l) => (l.trim() ? `> ${l}` : '>'))
    .join('\n');

function pipeTable(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const width = Math.max(header.length, ...rows.map((r) => r.length));
  const pad = (r: readonly string[]) => Array.from({ length: width }, (_, i) => cell(r[i] ?? ''));
  const line = (r: readonly string[]) => `| ${pad(r).join(' | ')} |`;
  return [line(header), `| ${Array.from({ length: width }, () => '---').join(' | ')} |`, ...rows.map(line)].join('\n');
}

/** "title. alt" without doubling a period the title already ends with. */
const sentences = (a: string, b: string): string => (b.trim() ? `${a.trim().replace(/[.]+$/, '')}. ${b.trim()}` : a);

const CALLOUT_PREFIX = { note: 'Note', warning: 'Warning', keypoint: 'Key point' } as const;

/** Markdown for one block, in the document's reading order (10 §5.2 block rendering). */
export function blockToMarkdown(b: DocBlock): string {
  switch (b.type) {
    case 'paragraph':
      return esc(b.md).trim();
    case 'list':
      return b.items.map((it, i) => `${b.ordered ? `${String(i + 1)}.` : '-'} ${oneLine(it)}`).join('\n');
    case 'pullquote':
      return b.attribution ? `${quote(b.text)}\n>\n> — ${oneLine(b.attribution)}` : quote(b.text);
    case 'callout':
      return quote(`**${CALLOUT_PREFIX[b.tone]}:** ${b.md}`);
    case 'analogy':
      return quote(`**Think of it like:** ${b.md}`);
    case 'table': {
      const t = pipeTable(b.header, b.rows);
      return b.caption ? `${t}\n\n${italic(b.caption)}` : t;
    }
    case 'chart': {
      const c = b.chart;
      const header = [c.xLabel ?? '', ...c.series.map((s) => s.name)];
      const rows = c.categories.map((cat, i) => [
        cat,
        ...c.series.map((s) => {
          const v = s.values[i];
          return v === null || v === undefined ? '-' : `${String(v)}${c.unit ? ` ${c.unit}` : ''}`;
        }),
      ]);
      const parts = [italic(c.subtitle ? `${c.title}: ${c.subtitle}` : c.title), pipeTable(header, rows)];
      if (c.highlight) parts.push(`**${oneLine(c.highlight.category)}:** ${oneLine(c.highlight.note)}`);
      if (c.source) parts.push(`Source: ${oneLine(c.source)}`);
      return parts.join('\n\n');
    }
    case 'diagram':
      return italic(sentences(b.title, b.alt));
    case 'figure':
      return italic(sentences(b.caption, b.alt));
    case 'stepper':
      return [
        `**${oneLine(b.title)}**`,
        b.steps.map((s, i) => `${String(i + 1)}. **${oneLine(s.label)}** ${oneLine(s.md)}`).join('\n'),
      ].join('\n\n');
  }
}

function referenceLine(r: ReferenceEntry): string {
  const label = r.href ? `[${oneLine(r.label).replace(/[[\]]/g, '\\$&')}](${r.href})` : oneLine(r.label);
  if (r.status === 'skipped') return `- ${label} (skipped${r.reason ? `: ${oneLine(r.reason)}` : ''})`;
  return r.detail ? `- ${label}: ${oneLine(r.detail)}` : `- ${label}`;
}

/**
 * The whole document as Markdown (10 §5.2): title as level 1, the subtitle as a paragraph, each tab
 * as level 2 (placeholder tabs skipped), each content section as level 3 with its blocks in
 * reading order, then the glossary, then one sources list built from the references. Reference
 * sections are skipped inline because the sources list replaces them.
 */
export function documentToMarkdown(model: DocumentModel): string {
  const out: string[] = [`# ${oneLine(model.title)}`];
  if (model.dek?.trim()) out.push(esc(model.dek).trim());
  for (const tab of model.tabs) {
    if (tab.placeholder) continue;
    out.push(`## ${oneLine(tab.label)}`);
    for (const s of tab.sections) {
      if (s.kind !== 'content') continue;
      out.push(`### ${oneLine(s.heading)}`);
      for (const b of s.blocks) {
        const md = blockToMarkdown(b);
        if (md) out.push(md);
      }
    }
  }
  if (model.glossary.length > 0) {
    out.push('## Glossary');
    out.push(
      model.glossary
        .map(
          (g) =>
            `- **${oneLine(g.term)}**${g.expansion ? ` (${oneLine(g.expansion)})` : ''}: ${oneLine(g.explanation)}`,
        )
        .join('\n'),
    );
  }
  if (model.references.length > 0) {
    out.push('## Sources');
    out.push(model.references.map(referenceLine).join('\n'));
  }
  return `${out.join('\n\n')}\n`;
}

// ---------------------------------------------------------------------------
// Publisher (10 §5.2)
// ---------------------------------------------------------------------------

export interface MarkdownPublisherOptions {
  home?: string;
  now?: () => Date;
  randomHex?: () => string;
  mkdir?: (p: string, opts: { recursive: true }) => Promise<unknown>;
}

/**
 * "Export Markdown" (10 §5.2): a second local publisher next to Export copy. Writes
 * `<export folder>/<slug>/<slug>.md` with the same folder preparation and atomic writing; never
 * touches the library copy.
 */
export class MarkdownPublisher implements Publisher {
  readonly id = 'markdown';
  readonly kind = 'local' as const;
  private readonly home: string;
  private readonly now: () => Date;
  private readonly randomHex: () => string;
  private readonly mkdir: (p: string, opts: { recursive: true }) => Promise<unknown>;

  constructor(opts: MarkdownPublisherOptions = {}) {
    this.home = opts.home ?? homedir();
    this.now = opts.now ?? (() => new Date());
    this.randomHex = opts.randomHex ?? (() => randomBytes(6).toString('hex'));
    this.mkdir = opts.mkdir ?? ((p, o) => fsMkdir(p, o));
  }

  describe(slug: string, settings: Settings): Promise<PublishTarget> {
    const dir = expandHome(settings.publish.local.dir, this.home);
    return Promise.resolve({
      id: this.id,
      kind: this.kind,
      label: 'Export Markdown',
      available: true,
      destinationPreview: abbreviateHome(join(dir, slug, `${slug}.md`), this.home),
      requiresSignIn: false,
    });
  }

  async publish(ctx: PublishContext): Promise<PublishResult> {
    if (ctx.signal.aborted) throw cancelled();
    const index = ctx.files.find((f) => f.relPath === 'index.html');
    if (!index) throw new PublishError('E_PUBLISH_FAILED', 'The document has nothing to export');
    let model: DocumentModel;
    try {
      model = parseDocument(await readFile(index.absPath, 'utf8')).model;
    } catch (err) {
      throw new PublishError('E_PUBLISH_FAILED', 'The document could not be read for Markdown export', err);
    }
    const data = Buffer.from(documentToMarkdown(model), 'utf8');

    const { destDir, shown } = await prepareExportDir(ctx, this.home, this.mkdir);
    if (ctx.signal.aborted) throw cancelled();
    const name = `${ctx.slug}.md`;
    const out = join(destDir, name);
    await writeExportFile(out, data, {
      expectedSha256: createHash('sha256').update(data).digest('hex'),
      shown,
      randomHex: this.randomHex,
    });

    if (ctx.settings.publish.local.revealAfter && ctx.reveal) {
      try {
        ctx.reveal(out);
      } catch {
        // Revealing is a convenience; the export already succeeded.
      }
    }
    return {
      targetId: this.id,
      kind: this.kind,
      slug: ctx.slug,
      publishedAt: this.now().toISOString(),
      files: [name],
      links: [{ kind: 'file', url: pathToFileURL(out).href, label: 'Open Markdown', primary: true }],
      warnings: [],
    };
  }
}
