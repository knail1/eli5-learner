/**
 * An in-memory `SyncLibrary` (the facade calls the sync engine uses, 09 §4.3) for engine tests:
 * documents with version trees and snapshot html, folders, Archive and Trash, read-only mode, and a
 * record of which snapshots were read under the document lock. Synthetic content only (13 §4).
 */
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import type {
  CatalogEntry,
  DocumentMeta,
  LibraryOrganization,
  VersionNodeRecord,
  VersionTreeFile,
  VersionTreeView,
} from '../../../../src/main/library';
import type { SyncLibrary } from '../../../../src/main/sync';

const TS = '2026-10-01T10:00:00.000Z';
let docSeq = 0;
let verSeq = 0;

export const sha256 = (b: Uint8Array | string): string => createHash('sha256').update(b).digest('hex');

interface MemDoc {
  entry: CatalogEntry;
  meta: DocumentMeta;
  tree: VersionTreeFile;
  html: Map<string, Buffer>;
}

export class MemLibrary implements SyncLibrary {
  readOnly = false;
  readonly docs = new Map<string, MemDoc>();
  org: LibraryOrganization = { folders: [], placement: {}, trash: [], trashRetentionDays: 30 };
  /** `<slug>:<versionId>` for each snapshot read under the document lock. */
  readonly lockedReads: string[] = [];
  private held = new Set<string>();
  private clock = Date.parse(TS);

  /** Adds a document with `versions` snapshots (the last one current). */
  add(title: string, versions = 1, over: { id?: string; html?: (i: number) => string } = {}): MemDoc {
    const id = over.id ?? `00000000-0000-4000-8000-${(++docSeq).toString(16).padStart(12, '0')}`;
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const createdAt = this.tick();
    const doc: MemDoc = {
      entry: {
        id,
        title,
        topicSlug: slug,
        createdAt,
        updatedAt: createdAt,
        summary: `About ${title}.`,
        summarySource: 'llm',
        tabCount: 2,
        mergedFromCount: 0,
      },
      meta: {
        schemaVersion: 1,
        id,
        topicSlug: slug,
        title,
        summary: `About ${title}.`,
        summarySource: 'llm',
        createdAt,
        updatedAt: createdAt,
        jobId: 'job-1',
        edition: 'public',
        clarifyingInput: ['PRIVATE', 'clarifying'].join('-'),
        glossaryEnabled: true,
        sourcesUsed: [{ ref: 'https://private.example.com/source', kind: 'url' }],
        sourcesSkipped: [],
        tabs: [
          { key: 'indepth', kind: 'indepth', label: 'In depth', sectionCount: 2, createdAt },
          { key: 'eli5', kind: 'eli5', label: 'ELI5', sectionCount: 2, createdAt },
        ],
        retiredIds: [],
        generation: { provider: 'claude', model: 'test-model', prompts: [] },
        warnings: [],
        merges: [],
        publications: [],
      },
      tree: { schemaVersion: 1, rootId: '', currentId: '', nodes: [] },
      html: new Map(),
    };
    this.docs.set(slug, doc);
    for (let i = 0; i < versions; i++) this.addVersion(slug, over.html?.(i));
    return doc;
  }

  /** A new current version (a section action, unless `over` names another kind, e.g. a rebuild). */
  addVersion(
    slug: string,
    html?: string,
    over: Partial<Pick<VersionNodeRecord, 'kind' | 'label' | 'topic'>> = {},
  ): VersionNodeRecord {
    const doc = this.need(slug);
    const id = `v-${(++verSeq).toString(16).padStart(12, '0')}`;
    const body = Buffer.from(
      html ?? `<!doctype html><html><body><h1>${doc.entry.title}</h1><p>${id}</p></body></html>`,
    );
    const parent = doc.tree.currentId || null;
    if (!parent && Object.keys(over).length > 0) throw new Error('addVersion: the first version is always initial');
    const node: VersionNodeRecord = {
      id,
      parentId: parent,
      createdAt: this.tick(),
      kind: parent ? 'expand' : 'initial',
      label: parent ? `expanded 'Section ${verSeq}'` : 'first version',
      topic: `Section ${verSeq}`,
      sha256: sha256(body),
      bytes: gzipSync(body).byteLength,
      ...(parent ? over : {}),
    };
    doc.tree.nodes.push(node);
    if (!parent) doc.tree.rootId = id;
    doc.tree.currentId = id;
    doc.html.set(id, body);
    doc.entry.updatedAt = node.createdAt;
    return node;
  }

  /** The same document under a new id (09 §7 step 4, or Put Back over a clash). */
  remint(slug: string, newId: string): void {
    const doc = this.need(slug);
    doc.entry = { ...doc.entry, id: newId };
    doc.meta = { ...doc.meta, id: newId };
  }

  moveToTrash(slug: string): void {
    const doc = this.need(slug);
    this.docs.delete(slug);
    this.org.trash.unshift({
      trashId: `${slug}--20261001T100000`,
      docId: doc.entry.id,
      title: doc.entry.title,
      topicSlug: slug,
      summary: doc.entry.summary,
      trashedAt: this.tick(),
      reason: 'trashed',
      from: 'unfiled',
    });
  }

  purge(docId: string): void {
    this.org.trash = this.org.trash.filter((t) => t.docId !== docId);
  }

  remove(slug: string): void {
    this.docs.delete(slug);
  }

  // ---- SyncLibrary ----
  list(): CatalogEntry[] {
    return [...this.docs.values()].map((d) => ({ ...d.entry }));
  }

  async getMeta(slug: string): Promise<DocumentMeta> {
    return structuredClone(this.need(slug).meta);
  }

  async versions(slug: string): Promise<VersionTreeView> {
    return {
      slug,
      tree: structuredClone(this.need(slug).tree),
      detached: false,
      readOnly: this.readOnly,
      degraded: false,
    };
  }

  async readVersion(slug: string, id: string): Promise<{ html: Buffer; meta: DocumentMeta; node: VersionNodeRecord }> {
    const doc = this.need(slug);
    if (this.held.has(slug)) this.lockedReads.push(`${slug}:${id}`);
    const node = doc.tree.nodes.find((n) => n.id === id);
    const html = doc.html.get(id);
    if (!node || !html) throw Object.assign(new Error('VERSION_NOT_FOUND'), { code: 'VERSION_NOT_FOUND' });
    return { html: Buffer.from(html), meta: structuredClone(doc.meta), node: { ...node } };
  }

  async withDocLock<T>(slug: string, fn: () => Promise<T>): Promise<T> {
    this.held.add(slug);
    try {
      return await fn();
    } finally {
      this.held.delete(slug);
    }
  }

  withDocLocks<T>(_slugs: string[], fn: () => Promise<T>): Promise<T> {
    return fn();
  }

  async organization(): Promise<LibraryOrganization> {
    return structuredClone(this.org);
  }

  private need(slug: string): MemDoc {
    const d = this.docs.get(slug);
    if (!d) throw Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' });
    return d;
  }

  private tick(): string {
    this.clock += 60_000;
    return new Date(this.clock).toISOString();
  }
}
