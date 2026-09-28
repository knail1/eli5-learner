import { describe, expect, it } from 'vitest';
import { DEFAULTS } from '../../../../src/main/config/schema';
import { NotAvailableInEdition } from '../../../../src/main/editions/errors';
import { DrivePublisherStub, GitPublisherStub, LocalPublisher, PublishError } from '../../../../src/main/publish';
import type { PublishContext, Publisher } from '../../../../src/main/publish';

function ctx(): PublishContext {
  return {
    slug: 'demo',
    title: 'Demo',
    files: [],
    settings: DEFAULTS,
    signal: new AbortController().signal,
    progress: () => {},
  };
}

describe('publisher stubs (10 §5.2, §5.3)', () => {
  const cases: [Publisher, string, string, string, boolean][] = [
    [new DrivePublisherStub(), 'drive', 'publisher:drive', 'HOOK-PUB-01', true],
    [new GitPublisherStub(), 'git', 'publisher:git', 'HOOK-PUB-03', false],
  ];

  for (const [p, id, capability, hookId, signIn] of cases) {
    it(`${id}: stub flag, id and kind`, () => {
      expect(p.stub).toBe(true);
      expect(p.id).toBe(id);
      expect(p.kind).toBe(id);
    });

    it(`${id}: publish throws NotAvailableInEdition with ${hookId}`, async () => {
      const err = await p.publish(ctx()).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(NotAvailableInEdition);
      const e = err as NotAvailableInEdition;
      expect(e.hookId).toBe(hookId);
      expect(e.capability).toBe(capability);
      expect(e.edition).toBe('public');
      expect(e.code).toBe('E_NOT_AVAILABLE_IN_EDITION');
    });

    it(`${id}: describe is unavailable and never exposes a hook ID`, async () => {
      const t = await p.describe('demo', DEFAULTS);
      expect(t).toMatchObject({ id, kind: id, available: false, requiresSignIn: signIn });
      expect(t.unavailableReason).toBe('Available in the enterprise edition');
      expect(t.label.length).toBeGreaterThan(0);
      expect(JSON.stringify(t)).not.toMatch(/HOOK-/);
    });
  }
});

describe('LocalPublisher (M0 placeholder, 10 §5.1)', () => {
  it('describe is available with a ~-abbreviated destination preview', async () => {
    const t = await new LocalPublisher().describe('revenue-recognition', DEFAULTS);
    expect(t).toMatchObject({
      id: 'local',
      kind: 'local',
      label: 'Export copy',
      available: true,
      requiresSignIn: false,
    });
    expect(t.destinationPreview).toBe('~/Documents/ELI5 Learner/revenue-recognition/');
    expect(JSON.stringify(t)).not.toMatch(/HOOK-/);
  });

  it('describe uses publish.local.dir', async () => {
    const s = {
      ...DEFAULTS,
      publish: { ...DEFAULTS.publish, local: { ...DEFAULTS.publish.local, dir: '/Volumes/Share/out' } },
    };
    const t = await new LocalPublisher().describe('x', s);
    expect(t.destinationPreview).toBe('/Volumes/Share/out/x/');
  });

  it('publish is not implemented yet', async () => {
    const err = await new LocalPublisher().publish(ctx()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PublishError);
    expect((err as PublishError).code).toBe('E_PUBLISH_FAILED');
  });
});
