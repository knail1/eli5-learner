import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MemorySink, RotatingFileSink, createLogger, sourceRef } from '../../../../src/main/security/log';

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

describe('RotatingFileSink (12 §11.1)', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });
  const setup = (start = Date.parse('2026-09-01T10:00:00Z')) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eli5-log-'));
    dirs.push(dir);
    const file = path.join(dir, 'main.log');
    let t = start;
    const clock = { now: () => new Date(t), advance: (ms: number) => (t += ms) };
    const sink = (opts: { maxBytes?: number; keepFiles?: number } = {}) =>
      new RotatingFileSink(file, { now: clock.now, ...opts });
    const files = () => fs.readdirSync(dir).sort();
    const read = (name: string) => fs.readFileSync(path.join(dir, name), 'utf8');
    return { dir, file, clock, sink, files, read };
  };
  const line = (tag: string, ts: Date) => JSON.stringify({ ts: ts.toISOString(), level: 'info', event: tag }) + '\n';

  it('starts a new file once the current one is a week old', () => {
    const { clock, sink, files, read } = setup();
    const s = sink();
    s.write(line('day0', clock.now()));
    clock.advance(6 * DAY);
    s.write(line('day6', clock.now()));
    expect(files()).toEqual(['main.log']);
    clock.advance(1 * DAY);
    s.write(line('day7', clock.now()));
    expect(files()).toEqual(['main.log', 'main.log.1']);
    expect(read('main.log.1')).toContain('day0');
    expect(read('main.log.1')).toContain('day6');
    expect(read('main.log')).toContain('day7');
    expect(read('main.log')).not.toContain('day0');
  });

  it('keeps the file age across restarts by reading the first line', () => {
    const { clock, sink, files } = setup();
    sink().write(line('first', clock.now()));
    clock.advance(8 * DAY);
    sink().write(line('after-restart', clock.now())); // a fresh sink, as after relaunching the app
    expect(files()).toEqual(['main.log', 'main.log.1']);
  });

  it('keeps four weeks of archives and deletes older ones', () => {
    const { clock, sink, files, read } = setup();
    const s = sink();
    for (let w = 0; w < 7; w++) {
      s.write(line(`week${w}`, clock.now()));
      clock.advance(7 * DAY);
    }
    expect(files()).toEqual(['main.log', 'main.log.1', 'main.log.2', 'main.log.3', 'main.log.4']);
    expect(read('main.log')).toContain('week6');
    expect(read('main.log.4')).toContain('week2');
  });

  it('still rotates by size within a week', () => {
    const { clock, sink, files } = setup();
    const s = sink({ maxBytes: 200 });
    for (let i = 0; i < 6; i++) s.write(line(`n${i}`.padEnd(40, '.'), clock.now()));
    expect(files().length).toBeGreaterThan(1);
    expect(files().length).toBeLessThanOrEqual(5);
  });

  it('removes archives beyond the limit left by an older version', () => {
    const { dir, clock, sink, files } = setup();
    for (const n of [5, 6, 9]) fs.writeFileSync(path.join(dir, `main.log.${n}`), 'old\n');
    sink().write(line('now', clock.now()));
    expect(files()).toEqual(['main.log']);
  });
});
