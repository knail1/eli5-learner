import { describe, expect, it, vi } from 'vitest';
import { notifyOnCreateDone } from '../../../../src/main/shell/completion';

/** 11 §14.2: bootstrap posts "Document ready" for create jobs only, through an optional notifier. */

const done = (kind: 'create' | 'section') => ({
  jobId: 'job-1',
  kind,
  slug: 'solar-power',
  docId: 'doc-1',
  title: 'Solar power',
});

describe('notifyOnCreateDone (11 §14.2)', () => {
  it('calls documentReady with the catalog values for a finished create job', () => {
    const documentReady = vi.fn();
    notifyOnCreateDone(() => ({ documentReady }))(done('create'));
    expect(documentReady).toHaveBeenCalledWith({ slug: 'solar-power', docId: 'doc-1', title: 'Solar power' });
  });

  it('posts nothing for section jobs', () => {
    const documentReady = vi.fn();
    notifyOnCreateDone(() => ({ documentReady }))(done('section'));
    expect(documentReady).not.toHaveBeenCalled();
  });

  it('does nothing while no notifier is plugged in, and reads the slot at event time', () => {
    const m3: { notifier?: { documentReady(e: unknown): void } } = {};
    const listener = notifyOnCreateDone(() => m3.notifier);
    expect(() => listener(done('create'))).not.toThrow();
    const documentReady = vi.fn();
    m3.notifier = { documentReady };
    listener(done('create'));
    expect(documentReady).toHaveBeenCalledOnce();
  });

  it('never lets a notifier failure escape into the job queue', () => {
    const listener = notifyOnCreateDone(() => ({
      documentReady: () => {
        throw new Error('boom');
      },
    }));
    expect(() => listener(done('create'))).not.toThrow();
  });
});
