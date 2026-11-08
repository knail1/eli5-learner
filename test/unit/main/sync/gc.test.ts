/** Garbage collection plan (16 §4.7): ages, acks, attachments, silent phones and old claims. */
import { describe, expect, it } from 'vitest';
import {
  GC_ABSENT_DOC_MS,
  GC_PHONE_SILENT_MS,
  GC_TERMINAL_JOB_MS,
  GC_UNSELECTED_BLOB_MS,
  planGc,
  type GcDoc,
  type GcInput,
} from '../../../../src/main/sync';
import type { RemoteFile, RemoteProps } from '../../../../src/main/sync';

const ME = '0b7c5e2a-1f3d-4c4e-9a8b-2d6f0e1c3b5a';
const PHONE = '2d9e7a4c-3b5f-4e6a-9c8d-4f8b2a3e5d7c';
const DOC = '6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b';
const JOB = '0192f0c4-7d1e-7a2b-8c3d-4e5f6a7b8c9d';
const JOB2 = '0192f0c4-7d1e-7a2b-8c3d-4e5f6a7b8c9e';
const NOW = Date.parse('2026-11-01T12:00:00Z');
const sha = (n: number) => n.toString(16).padStart(64, '0');

let seq = 0;
const file = (props: RemoteProps, modifiedTime = new Date(NOW).toISOString()): RemoteFile => ({
  id: `f${++seq}`,
  name: '',
  props,
  modifiedTime,
});

function input(over: Partial<GcInput>): GcInput {
  return {
    now: NOW,
    me: ME,
    files: [],
    docs: new Map(),
    terminal: new Map(),
    jobAttachments: new Map(),
    acks: new Map(),
    devices: new Map(),
    claims: [],
    ...over,
  };
}

const doc = (over: Partial<GcDoc> = {}): GcDoc => ({
  inManifest: true,
  purged: false,
  selected: new Set([sha(1)]),
  unselectedSinceMs: {},
  ...over,
});

describe('planGc (16 §4.7)', () => {
  const blob1 = file({ k: 'blob', dev: ME, d: DOC, s: sha(1) });
  const blob2 = file({ k: 'blob', dev: ME, d: DOC, s: sha(2) });
  const tree = file({ k: 'tree', dev: ME, d: DOC, n: 3 });

  it('collects a purged document at once and an absent one after 30 days', () => {
    const files = [blob1, tree];
    expect(planGc(input({ files, docs: new Map([[DOC, doc({ inManifest: false, purged: true })]]) }))).toHaveLength(2);
    const absent = (ms: number) =>
      planGc(input({ files, docs: new Map([[DOC, doc({ inManifest: false, absentSinceMs: NOW - ms })]]) }));
    expect(absent(GC_ABSENT_DOC_MS - 1000)).toHaveLength(0);
    expect(absent(GC_ABSENT_DOC_MS + 1000).map((d) => d.reason)).toEqual(['doc-gone', 'doc-gone']);
  });

  it('collects a blob no longer selected after 7 days, never a selected one', () => {
    const files = [blob1, blob2, tree];
    const at = (ms: number) =>
      planGc(input({ files, docs: new Map([[DOC, doc({ unselectedSinceMs: { [sha(2)]: NOW - ms } })]]) }));
    expect(at(GC_UNSELECTED_BLOB_MS - 1000)).toHaveLength(0);
    expect(at(GC_UNSELECTED_BLOB_MS + 1000)).toEqual([{ fileId: blob2.id, kind: 'blob', reason: 'unselected' }]);
  });

  it('never touches another device’s blobs or trees, nor documents it does not know', () => {
    const foreign = file({ k: 'blob', dev: PHONE, d: DOC, s: sha(9) });
    const unknown = file({ k: 'tree', dev: ME, d: '00000000-0000-4000-8000-000000000009' });
    const plan = planGc(
      input({ files: [foreign, unknown], docs: new Map([[DOC, doc({ inManifest: false, purged: true })]]) }),
    );
    expect(plan).toEqual([]);
  });

  it('collects job, cancel, status and attachment files once the sender acknowledged a terminal job', () => {
    const job = file({ k: 'job', dev: PHONE, s: JOB });
    const cancel = file({ k: 'cancel', dev: PHONE, s: JOB });
    const status = file({ k: 'status', dev: ME, s: JOB });
    const att = file({ k: 'att', dev: PHONE, s: sha(5) });
    const shared = file({ k: 'att', dev: PHONE, s: sha(6) });
    const job2 = file({ k: 'job', dev: PHONE, s: JOB2 });
    const base = {
      files: [job, cancel, status, att, shared, job2],
      terminal: new Map([[JOB, NOW - 1000]]),
      jobAttachments: new Map([
        [JOB, [sha(5), sha(6)]],
        [JOB2, [sha(6)]],
      ]),
    };
    expect(planGc(input(base))).toEqual([]); // terminal but not acknowledged, and recent
    const acked = planGc(input({ ...base, acks: new Map([[PHONE, new Set([JOB])]]) }));
    expect(acked.map((d) => d.fileId).sort()).toEqual([job.id, cancel.id, status.id, att.id].sort());
    // 30 days after turning terminal, acks are not needed.
    const old = planGc(input({ ...base, terminal: new Map([[JOB, NOW - GC_TERMINAL_JOB_MS - 1000]]) }));
    expect(old.map((d) => d.fileId)).toContain(job.id);
    expect(old.map((d) => d.fileId)).not.toContain(shared.id); // still named by JOB2
  });

  it('collects an attachment no job names after 30 days', () => {
    const fresh = file({ k: 'att', dev: PHONE, s: sha(7) }, new Date(NOW - 1000).toISOString());
    const stale = file({ k: 'att', dev: PHONE, s: sha(8) }, new Date(NOW - 31 * 86_400_000).toISOString());
    expect(planGc(input({ files: [fresh, stale] }))).toEqual([{ fileId: stale.id, kind: 'att', reason: 'orphan-att' }]);
  });

  it('collects the device file and acks of a phone silent for 180 days, never a desktop', () => {
    const MAC = '1c8d6f3b-2a4e-4d5f-8b9c-3e7a1f2d4c6b';
    const files = [file({ k: 'device', dev: PHONE }), file({ k: 'acks', dev: PHONE }), file({ k: 'device', dev: MAC })];
    const devices = new Map([
      [PHONE, { platform: 'android' as const, seenMs: NOW - GC_PHONE_SILENT_MS - 1000 }],
      [MAC, { platform: 'macos' as const, seenMs: NOW - GC_PHONE_SILENT_MS - 1000 }],
    ]);
    expect(planGc(input({ files, devices })).map((d) => d.reason)).toEqual(['phone-silent', 'phone-silent']);
    devices.set(PHONE, { platform: 'android', seenMs: NOW - 1000 });
    expect(planGc(input({ files, devices }))).toEqual([]);
  });

  it('collects every claim but the newest', () => {
    const a = file({ k: 'claim', dev: ME, n: 1 });
    const b = file({ k: 'claim', dev: PHONE, n: 2 });
    const cl = file({ k: 'claim', dev: ME, n: 3 });
    const claims = [a, b, cl].map((f) => ({ fileId: f.id, deviceId: f.props.dev, ms: f.props.n! }));
    expect(
      planGc(input({ files: [a, b, cl], claims }))
        .map((d) => d.fileId)
        .sort(),
    ).toEqual([a.id, b.id].sort());
  });
});
