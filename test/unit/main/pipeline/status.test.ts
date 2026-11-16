import { describe, expect, it } from 'vitest';
import type { JobStatus } from '../../../../src/main/pipeline';
import {
  assertTransition,
  canTransition,
  IllegalTransitionError,
  statusLine,
  truncateTitle,
} from '../../../../src/main/pipeline';
import type { StatusLineJob } from '../../../../src/main/pipeline';
import type { SourceInput } from '../../../../src/preload/contract';

const url = (n: number): SourceInput => ({ id: `u${n}`, kind: 'url', origin: 'url-field', url: `https://e.x/${n}` });

function job(over: Partial<StatusLineJob> = {}): StatusLineJob {
  return {
    kind: 'create',
    status: 'queued',
    inputs: [url(1)],
    progress: { sourcesTotal: 1, sourcesDone: 0, stepsPlanned: ['indepth', 'eli5', 'summary'] },
    skipped: [],
    warnings: [],
    ...over,
  };
}

const done = (over: Partial<StatusLineJob> = {}) =>
  job({ status: 'done', result: { docId: 'd', topicSlug: 's', title: 'How DNS works' }, ...over });

describe('statusLine (06 §6)', () => {
  it('queued', () => {
    expect(statusLine(job())).toBe('Queued');
    expect(statusLine(job(), { queuePosition: 0 })).toBe('Queued');
    // 06 §6: position 1 names the run to wait for only when there is a single slot.
    expect(statusLine(job(), { queuePosition: 1 })).toBe('Queued: starts after the current run');
    expect(statusLine(job(), { queuePosition: 1, queueSlots: 1 })).toBe('Queued: starts after the current run');
    expect(statusLine(job(), { queuePosition: 1, queueSlots: 3 })).toBe('Queued: starts when a run finishes');
    expect(statusLine(job(), { queuePosition: 2, queueSlots: 3 })).toBe('Queued (2 ahead)');
    expect(statusLine(job(), { queuePosition: 3 })).toBe('Queued (3 ahead)');
    expect(statusLine(job({ resuming: true }), { queuePosition: 3 })).toBe('Resuming');
  });

  it('reading', () => {
    const p = { sourcesTotal: 5, sourcesDone: 2, stepsPlanned: [] };
    expect(statusLine(job({ status: 'reading', progress: p }))).toBe('Reading sources (2 of 5)');
    expect(statusLine(job({ status: 'reading' }))).toBe('Reading sources');
  });

  it('extracting and saving', () => {
    expect(statusLine(job({ status: 'extracting' }))).toBe('Extracting content');
    expect(statusLine(job({ status: 'saving' }))).toBe('Saving');
  });

  it('generating', () => {
    const g = job({ status: 'generating' });
    expect(statusLine(g, { runningSteps: ['indepth', 'eli5'] })).toBe('Generating document (in-depth and ELI5)');
    expect(statusLine(g, { runningSteps: ['indepth'] })).toBe('Generating document (in-depth explainer)');
    expect(statusLine(g, { runningSteps: ['eli5'] })).toBe('Generating document (ELI5 version)');
    // Step 1b (06 §5.4): the ASD-STE100 tab and the ELI5 critique, together or alone.
    expect(statusLine(g, { runningSteps: ['ste', 'eli5-critique'] })).toBe(
      'Generating document (ASD-STE100 version, simplifying the ELI5 version)',
    );
    expect(statusLine(g, { runningSteps: ['ste'] })).toBe('Generating document (ASD-STE100 version)');
    expect(statusLine(g, { runningSteps: ['eli5-critique'] })).toBe(
      'Generating document (simplifying the ELI5 version)',
    );
    expect(statusLine(g, { runningSteps: ['glossary'] })).toBe('Generating document (glossary notes)');
    expect(statusLine(g, { runningSteps: ['summary'] })).toBe('Generating document (finishing up)');
    const withStep = job({
      status: 'generating',
      progress: { sourcesTotal: 1, sourcesDone: 1, step: 'summary', stepsPlanned: [] },
    });
    expect(statusLine(withStep)).toBe('Generating document (finishing up)');
    expect(statusLine(g)).toBe('Generating document');
  });

  it('done', () => {
    expect(statusLine(done())).toBe('Done: How DNS works');
    const skipped = [{}, {}] as unknown as StatusLineJob['skipped'];
    expect(statusLine(done({ skipped }))).toBe('Done: How DNS works · 2 source(s) skipped');
    expect(statusLine(done({ warnings: [{ kind: 'glossary-omitted', message: 'x' }] }))).toBe(
      'Done: How DNS works · with notes',
    );
    expect(statusLine(done({ warnings: [{ kind: 'ste-omitted', message: 'x' }] }))).toBe(
      'Done: How DNS works · with notes',
    );
  });

  it('failed with no usable content: one source appends its skip reason, several keep the count (06 §6)', () => {
    const f = (inputs: StatusLineJob['inputs'], skipped: StatusLineJob['skipped']) =>
      statusLine(job({ status: 'failed', inputs, skipped, failure: { code: 'NO_USABLE_CONTENT', message: '' } }));
    const skip = (reason: string) => ({ ref: 'memo.pdf', reason, code: 'too-large' as const });
    expect(f([url(1)], [skip('File is larger than the supported size.')])).toBe(
      'Failed: no usable content in 1 source(s) · File is larger than the supported size',
    );
    expect(f([url(1)], [skip('page could not be fetched')])).toBe(
      'Failed: no usable content in 1 source(s) · Page could not be fetched',
    );
    // One source without a reason, and several sources, keep the count alone.
    expect(f([url(1)], [])).toBe('Failed: no usable content in 1 source(s)');
    expect(f([url(1)], [skip('  ')])).toBe('Failed: no usable content in 1 source(s)');
    expect(f([url(1), url(2)], [skip('File not found.'), skip('File not found.')])).toBe(
      'Failed: no usable content in 2 source(s)',
    );
  });

  it('truncates titles longer than 60 characters', () => {
    const long = 'x'.repeat(61);
    expect(truncateTitle('x'.repeat(60))).toBe('x'.repeat(60));
    expect(truncateTitle(long)).toBe(`${'x'.repeat(59)}…`);
    expect(statusLine(done({ result: { docId: 'd', topicSlug: 's', title: long } }))).toBe(`Done: ${'x'.repeat(59)}…`);
  });

  it('failed', () => {
    const f = (code: NonNullable<StatusLineJob['failure']>['code'], inputs = [url(1)]) =>
      statusLine(job({ status: 'failed', inputs, failure: { code, message: '' } }));
    expect(f('NO_USABLE_CONTENT', [url(1), url(2), url(3)])).toBe('Failed: no usable content in 3 source(s)');
    expect(f('LLM_AUTH')).toBe('Failed: API key rejected. Check Settings');
    expect(f('LLM_UNAVAILABLE')).toBe('Failed: AI service unavailable. Try again later');
    expect(f('SAVE_FAILED')).toBe('Failed: could not save the document');
    expect(f('CANCELLED')).toBe('Cancelled');
    expect(f('INTERRUPTED')).toBe('Failed: interrupted by app restart');
    expect(f('INTERNAL')).toBe('Failed: something went wrong');
    expect(f('SECTION_TOO_LARGE')).toBe('Failed: section too long to rewrite');
    expect(f('SECTION_GONE')).toBe('Failed: section no longer exists');
    expect(f('SECTION_CHANGED')).toBe('Failed: section changed, try again');
    expect(f('DOC_GONE')).toBe('Failed: document no longer exists');
  });

  it('section jobs', () => {
    const section = {
      slug: 's',
      tabKey: 'indepth',
      sectionId: 'sec-indepth-0123abcd',
      action: 'expand',
      selectionText: 'abc',
      heading: 'Resolvers',
      baseHash: 'h',
    } as NonNullable<StatusLineJob['section']>;
    const s = (over: Partial<StatusLineJob>) => job({ kind: 'section', inputs: [], section, ...over });
    expect(statusLine(s({ status: 'generating' }))).toBe('Updating section: Resolvers');
    expect(statusLine(s({ status: 'done' }))).toBe('Updated: Resolvers');
    const eli5 = { ...section, action: 'eli5-tab' as const };
    expect(statusLine(s({ status: 'generating', section: eli5 }))).toBe('Adding ELI5 tab: Resolvers');
    expect(statusLine(s({ status: 'done', section: eli5 }), { tabLabel: 'ELI5: Resolvers' })).toBe(
      'Added tab: ELI5: Resolvers',
    );
    const focused = { ...section, action: 'eli5-selection' as const };
    expect(statusLine(s({ status: 'generating', section: focused }))).toBe(
      'Adding ELI5 tab for a selection: Resolvers',
    );
    expect(statusLine(s({ status: 'done', section: focused }), { tabLabel: 'ELI5: Caching' })).toBe(
      'Added tab: ELI5: Caching',
    );
    expect(statusLine(s({ status: 'failed', failure: { code: 'SECTION_GONE', message: '' } }))).toBe(
      'Failed: section no longer exists',
    );
    const ask = { ...section, action: 'ask' as const, question: 'Why cache at all?' };
    expect(statusLine(s({ status: 'queued', section: ask }))).toBe('Answering a question: Resolvers');
    expect(statusLine(s({ status: 'generating', section: ask }))).toBe('Answering a question: Resolvers');
    expect(statusLine(s({ status: 'saving', section: ask }))).toBe('Answering a question: Resolvers');
    // The done line names the section, never a tab, even when a tab label is known.
    expect(statusLine(s({ status: 'done', section: ask }), { tabLabel: 'ELI5: Caching' })).toBe('Answered: Resolvers');
    expect(statusLine(s({ status: 'failed', section: ask, failure: { code: 'SECTION_CHANGED', message: '' } }))).toBe(
      'Failed: section changed, try again',
    );
  });

  it('a Deep Ask has its own running and done lines (08 §6.9)', () => {
    const deep = {
      slug: 's',
      tabKey: 'indepth',
      sectionId: 'sec-indepth-0123abcd',
      action: 'ask',
      selectionText: 'abc',
      question: 'Why cache at all?',
      depth: 'deep',
      heading: 'Resolvers',
      baseHash: 'h',
    } as NonNullable<StatusLineJob['section']>;
    const s = (over: Partial<StatusLineJob>) => job({ kind: 'section', inputs: [], section: deep, ...over });
    for (const status of ['queued', 'generating', 'saving'] as const) {
      expect(statusLine(s({ status, section: deep }))).toBe('Answering in depth: Resolvers');
    }
    expect(statusLine(s({ status: 'done', section: deep }), { tabLabel: 'ELI5: Caching' })).toBe(
      'Answered in depth: Resolvers',
    );
    expect(statusLine(s({ status: 'failed', section: deep, failure: { code: 'SECTION_CHANGED', message: '' } }))).toBe(
      'Failed: section changed, try again',
    );
    // 08 §9: too much context, not a long section; a quick Ask keeps the rewrite wording.
    const tooLarge = { code: 'SECTION_TOO_LARGE', message: '' } as const;
    expect(statusLine(s({ status: 'failed', section: deep, failure: tooLarge }))).toBe(
      'Failed: question needs more context than the model allows',
    );
    const { depth: _d, ...quick } = deep;
    expect(statusLine(s({ status: 'failed', section: quick, failure: tooLarge }))).toBe(
      'Failed: section too long to rewrite',
    );
  });
});

describe('Ask deeper status lines (08 §6.10, 06 §6)', () => {
  it('has its own running and done lines and the deep SECTION_TOO_LARGE line', () => {
    const deeper = {
      slug: 's',
      tabKey: 'indepth',
      sectionId: 'sec-indepth-0123abcd',
      action: 'ask',
      selectionText: 'abc',
      question: 'Why cache at all?',
      depth: 'deeper',
      heading: 'Resolvers',
      baseHash: 'h',
    } as NonNullable<StatusLineJob['section']>;
    const s = (over: Partial<StatusLineJob>) => job({ kind: 'section', inputs: [], section: deeper, ...over });
    for (const status of ['queued', 'generating', 'saving'] as const) {
      expect(statusLine(s({ status }))).toBe('Searching further: Resolvers');
    }
    expect(statusLine(s({ status: 'done' }))).toBe('Answered (deeper): Resolvers');
    expect(statusLine(s({ status: 'failed', failure: { code: 'SECTION_TOO_LARGE', message: '' } }))).toBe(
      'Failed: question needs more context than the model allows',
    );
  });
});

describe('canTransition (06 §3.2)', () => {
  const all: JobStatus[] = ['queued', 'reading', 'extracting', 'generating', 'saving', 'done', 'failed'];
  const legalCreate = new Set([
    'queued>reading',
    'reading>extracting',
    'extracting>generating',
    'generating>saving',
    'saving>done',
    'queued>failed',
    'reading>failed',
    'extracting>failed',
    'generating>failed',
    'saving>failed',
    'failed>queued',
    'reading>queued',
    'extracting>queued',
    'generating>queued',
    'saving>queued',
  ]);

  it('matches the table exactly for create jobs', () => {
    for (const from of all)
      for (const to of all) expect(canTransition(from, to), `${from}>${to}`).toBe(legalCreate.has(`${from}>${to}`));
  });

  it('allows queued -> generating only for section jobs (06 §8.2)', () => {
    expect(canTransition('queued', 'generating')).toBe(false);
    expect(canTransition('queued', 'generating', 'create')).toBe(false);
    expect(canTransition('queued', 'generating', 'section')).toBe(true);
  });

  it('done is terminal; no self transitions', () => {
    for (const to of all) expect(canTransition('done', to)).toBe(false);
    for (const s of all) expect(canTransition(s, s)).toBe(false);
  });

  it('assertTransition throws IllegalTransitionError', () => {
    expect(() => assertTransition('queued', 'reading')).not.toThrow();
    expect(() => assertTransition('done', 'queued')).toThrow(IllegalTransitionError);
    expect(() => assertTransition('queued', 'saving')).toThrow(IllegalTransitionError);
  });
});
