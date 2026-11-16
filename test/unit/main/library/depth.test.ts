/** Ask deep and Ask deeper's `depth` flag on ask records and version nodes (08 §6.9, §6.10, 09 §4.1, §5.2). */
import { describe, expect, it } from 'vitest';
import {
  AskRecordSchema,
  VersionNodeRecordSchema,
  toWire,
  type SectionId,
  type VersionNodeRecord,
} from '../../../../src/main/library';
import { HTML, makeMeta, testLibrary, writeDocFolder } from './fixtures';

const SEC = 'sec-indepth-0000abcd' as SectionId;
const ask = {
  at: '2026-01-01T00:00:00.000Z',
  sectionId: SEC,
  tabKey: 'indepth',
  question: 'Why do widgets cost more?',
  qaId: 'q-0a0b0c0d',
  jobId: 'job-1',
};
const node: VersionNodeRecord = {
  id: 'v-000000000001',
  parentId: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  kind: 'ask',
  label: "asked (deep) about 'Cost'",
  topic: 'Cost',
  sha256: 'a'.repeat(64),
  bytes: 10,
};

describe('depth on records', () => {
  it('ask records and version nodes accept depth deep and deeper; old records still parse; other values are dropped', () => {
    expect(AskRecordSchema.parse(ask)).toEqual(ask);
    expect(AskRecordSchema.parse({ ...ask, depth: 'deep' }).depth).toBe('deep');
    expect(AskRecordSchema.parse({ ...ask, depth: 'deeper' }).depth).toBe('deeper');
    // 08 §6.10 item 9: a value from a newer app is dropped, never a parse failure of meta.json.
    expect(AskRecordSchema.parse({ ...ask, depth: 'quick' })).toEqual(ask);
    expect(VersionNodeRecordSchema.parse(node)).toEqual(node);
    expect(VersionNodeRecordSchema.parse({ ...node, depth: 'deep' }).depth).toBe('deep');
    expect(VersionNodeRecordSchema.parse({ ...node, depth: 'deeper' }).depth).toBe('deeper');
    expect(VersionNodeRecordSchema.parse({ ...node, depth: 'shallow' })).toEqual(node);
  });

  it('toWire passes depth through and leaves it off quick nodes', () => {
    const view = (n: VersionNodeRecord) => ({
      slug: 'widget-pricing',
      tree: { schemaVersion: 1, rootId: n.id, currentId: n.id, nodes: [n] },
      detached: false,
      readOnly: false,
      degraded: false,
    });
    expect(toWire(view({ ...node, depth: 'deep' }), { busy: false, pending: [] }).nodes[0]).toMatchObject({
      depth: 'deep',
    });
    expect(toWire(view({ ...node, depth: 'deeper' }), { busy: false, pending: [] }).nodes[0]).toMatchObject({
      depth: 'deeper',
    });
    expect('depth' in (toWire(view(node), { busy: false, pending: [] }).nodes[0] ?? {})).toBe(false);
  });

  it('a change with depth deeper makes an Ask deeper node (08 §6.10)', async () => {
    const { lib } = await testLibrary();
    await writeDocFolder(lib.root, makeMeta({ topicSlug: 'widget-pricing' }));
    await lib.reconcile();
    await lib.withDocLock('widget-pricing', () =>
      lib.updateDocument('widget-pricing', {
        html: HTML.replace('Inc.', 'Inc. 1'),
        meta: (m) => m,
        label: "asked (deeper) about 'Cost'",
        change: { kind: 'ask', topic: 'Cost', question: 'Why?', depth: 'deeper' },
      }),
    );
    const tree = (await lib.versions('widget-pricing')).tree;
    expect(tree.nodes.find((n) => n.id === tree.currentId)).toMatchObject({ kind: 'ask', depth: 'deeper' });
  });

  it('a change with depth deep makes a deep ask node; depth on another kind is dropped', async () => {
    const { lib } = await testLibrary();
    await writeDocFolder(lib.root, makeMeta({ topicSlug: 'widget-pricing' }));
    await lib.reconcile();
    const write = (kind: 'ask' | 'expand', n: number) =>
      lib.withDocLock('widget-pricing', () =>
        lib.updateDocument('widget-pricing', {
          html: HTML.replace('Inc.', `Inc. ${n}`),
          meta: (m) => m,
          label: `change ${n}`,
          change: { kind, topic: 'Cost', question: 'Why?', depth: 'deep' },
        }),
      );
    await write('ask', 1);
    let tree = (await lib.versions('widget-pricing')).tree;
    expect(tree.nodes.find((n) => n.id === tree.currentId)).toMatchObject({ kind: 'ask', depth: 'deep' });
    await write('expand', 2);
    tree = (await lib.versions('widget-pricing')).tree;
    expect(tree.nodes.find((n) => n.id === tree.currentId)?.depth).toBeUndefined();
  });
});
