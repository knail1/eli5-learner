import { describe, expect, it } from 'vitest';
import { MemorySink, createLogger, sourceRef } from '../../../../src/main/security/log';

const make = (strictFields = false) => {
  const sink = new MemorySink();
  const log = createLogger({ sink, strictFields, now: () => new Date('2026-01-01T00:00:00Z'), appRoot: '/app' });
  return { sink, log };
};

describe('logger (12 §11)', () => {
  it('writes JSON lines with allowlisted fields only', () => {
    const { sink, log } = make();
    log.info('job.transition', { jobId: 'j1', from: 'queued', to: 'reading', prompt: 'secret text' });
    const [warn, line] = sink.entries();
    expect(warn).toMatchObject({ event: 'log.unknown-field', kind: 'prompt' });
    expect(line).toEqual({
      ts: '2026-01-01T00:00:00.000Z',
      level: 'info',
      event: 'job.transition',
      jobId: 'j1',
      from: 'queued',
      to: 'reading',
    });
    expect(sink.lines.join()).not.toContain('secret text');
  });

  it('throws on unknown fields in dev builds', () => {
    expect(() => make(true).log.info('x', { content: 'a' })).toThrow(/allowlist/);
  });

  it('truncates and redacts strings', () => {
    const { sink, log } = make();
    const key = ['sk', 'ant', 'z'.repeat(30)].join('-');
    log.warn('llm.call', { model: `m ${key}`, path: 'p'.repeat(300) });
    const e = sink.entries()[0]!;
    expect(e.model).toBe('m [REDACTED]');
    expect((e.path as string).length).toBe(200);
  });

  it('logs error name and code and a stack without the message', () => {
    const { sink, log } = make();
    const err = Object.assign(new Error('provider echoed the prompt'), { code: 'E_X' });
    log.error('llm.failed', { provider: 'claude' }, err);
    const e = sink.entries()[0]!;
    expect(e).toMatchObject({ errName: 'Error', errCode: 'E_X' });
    expect(JSON.stringify(e)).not.toContain('provider echoed the prompt');
  });

  it('suppresses debug unless enabled', () => {
    const { sink, log } = make();
    log.debug('x');
    expect(sink.lines).toEqual([]);
  });

  it('sourceRef keeps basenames and query-less URLs', () => {
    expect(sourceRef('/Users/someone/Desktop/Q3 deck.pptx')).toBe('Q3 deck.pptx');
    expect(sourceRef('https://example.com/a/b?token=1#x')).toBe('https://example.com/a/b');
    expect(sourceRef('clipboard:image')).toBe('clipboard:image');
  });
});
