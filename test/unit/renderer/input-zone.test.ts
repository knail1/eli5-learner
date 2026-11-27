import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SourceInput } from '../../../src/preload/contract';
import {
  button,
  click,
  flush,
  installFakeApi,
  key,
  loadRenderer,
  ok,
  render,
  type,
  type Component,
  type FakeApi,
} from './harness';

const { InputZone } = await loadRenderer<{ InputZone: Component }>('input/InputZone.tsx');
const { AnnouncerProvider } = await loadRenderer<{ AnnouncerProvider: Component }>('a11y/Announcer.tsx');
const { createElement } = await import('react');

let fake: FakeApi;
beforeEach(() => {
  fake = installFakeApi();
});

function Zone(props: Record<string, unknown>) {
  return createElement(AnnouncerProvider, null, createElement(InputZone, props));
}

async function mount(over: Record<string, unknown> = {}) {
  const host = await render(Zone, { glossaryDefault: true, provider: 'claude', onOpenSettings: () => {}, ...over });
  const url = host.querySelector<HTMLInputElement>('input[aria-label="URL"]');
  const specifics = host.querySelector<HTMLTextAreaElement>('textarea');
  return { host, url, specifics };
}

const labels = (host: HTMLElement, sel: string) =>
  Array.from(host.querySelectorAll(`${sel} .chip`)).map((c) => c.querySelector('.chip-label')?.textContent ?? '');
/** Chips the next Start sends. */
const added = (host: HTMLElement) => labels(host, 'ul[aria-label="Added sources"]');
/** The dimmed Last run row. */
const lastRun = (host: HTMLElement) => labels(host, '[aria-label="Last run"]');

describe('InputZone start algorithm (11 §5.4)', () => {
  it('Enter with nothing added shows an inline hint and does not start', async () => {
    const { host, url } = await mount();
    await key(url, 'Enter');
    expect(host.textContent).toContain('Add a file, paste, or URL first');
    expect(fake.api.jobs.start).not.toHaveBeenCalled();
  });

  it('clarifying text alone never starts a job', async () => {
    const { host, specifics } = await mount();
    await type(specifics, 'What is this about?');
    await key(specifics, 'Enter');
    expect(host.textContent).toContain('Add a file, paste, or URL first');
    expect(fake.api.jobs.start).not.toHaveBeenCalled();
  });

  it('non-URL text is invalid in the public build and keeps focus in the field', async () => {
    const { host, url } = await mount();
    url?.focus();
    await type(url, 'ABC-123');
    await key(url, 'Enter');
    expect(host.textContent).toContain('Enter a web address that starts with http:// or https://');
    expect(url?.value).toBe('ABC-123');
    expect(url?.getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(url);
    expect(fake.api.jobs.start).not.toHaveBeenCalled();
  });

  it('without an API key shows the Settings hint', async () => {
    let opened = 0;
    const { host, url } = await mount({ onOpenSettings: () => (opened += 1) });
    await type(url, 'https://example.com/article');
    await click(button(host, 'Start'));
    expect(host.textContent).toContain('Add an API key in Settings to start');
    expect(fake.api.jobs.start).not.toHaveBeenCalled();
    await click(button(host, 'Open Settings'));
    expect(opened).toBe(1);
  });

  it('Enter in the URL field turns each valid address into a chip and starts nothing', async () => {
    const { host, url } = await mount();
    await type(url, 'https://example.com/a https://example.org/b oops');
    await key(url, 'Enter');
    expect(added(host)).toEqual(['example.com/a', 'example.org/b']);
    expect(url?.value).toBe('oops');
    expect(host.textContent).toContain('Enter a web address that starts with http:// or https://');
    expect(fake.api.settings.hasApiKey).not.toHaveBeenCalled();
    expect(fake.api.jobs.start).not.toHaveBeenCalled();
    // Modified Enter and text composition never add.
    await type(url, 'https://example.net/c');
    await key(url, 'Enter', { shiftKey: true });
    expect(added(host)).toHaveLength(2);
  });

  it('Add does the same as Enter, is disabled while the field is empty, and returns focus to the field', async () => {
    const { host, url } = await mount();
    expect(button(host, 'Add')?.disabled).toBe(true);
    await type(url, 'https://example.com/a');
    expect(button(host, 'Add')?.disabled).toBe(false);
    await click(button(host, 'Add'));
    expect(added(host)).toEqual(['example.com/a']);
    expect(url?.value).toBe('');
    expect(button(host, 'Add')?.disabled).toBe(true);
    expect(document.activeElement).toBe(url);
    expect(fake.api.jobs.start).not.toHaveBeenCalled();
  });

  it('Cmd+Enter starts from anywhere in the zone; sent inputs leave the chips and their URLs become the last run', async () => {
    fake.api.settings.hasApiKey = async () => ok(true);
    const calls: unknown[] = [];
    fake.api.jobs.start = vi.fn(async (r) => {
      calls.push(r);
      return ok({ jobId: 'job-1' });
    }) as unknown as typeof fake.api.jobs.start;
    const { host, url, specifics } = await mount();
    await act(async () => {
      window.dispatchEvent(new CustomEvent('eli5:test:drop-paths', { detail: ['/Users/x/quarterly-review.pptx'] }));
    });
    await flush();
    await type(url, 'https://example.com/a https://example.org/b');
    await type(specifics, 'Focus on pricing');
    await click(host.querySelector('input[role="switch"]'));
    await key(specifics, 'Enter', { metaKey: true });

    expect(calls).toHaveLength(1);
    const req = calls[0] as { inputs: SourceInput[]; options: unknown; draftId?: string };
    expect(req.options).toEqual({ clarifyingInput: 'Focus on pricing', glossary: false });
    expect(req.draftId).toBeUndefined();
    expect(req.inputs.map((i) => (i.kind === 'file' ? i.path : i.kind === 'url' ? i.url : ''))).toEqual([
      '/Users/x/quarterly-review.pptx',
      'https://example.com/a',
      'https://example.org/b',
    ]);
    expect(req.inputs[0]).toMatchObject({ kind: 'file', origin: 'drop' });

    // 11 §5.4 step 5: every sent input leaves the chips; the URLs are the dimmed Last run with Use
    // again; Specifics and the glossary choice stay; the button reads Run again.
    expect(added(host)).toEqual([]);
    expect(lastRun(host)).toEqual(['example.com/a', 'example.org/b']);
    expect(host.querySelector('[aria-label="Last run"] .chip-remove')).toBeNull();
    expect(button(host, 'Use again')).toBeDefined();
    expect(url?.value).toBe('');
    expect(specifics?.value).toBe('Focus on pricing');
    expect(host.querySelector<HTMLInputElement>('input[role="switch"]')?.checked).toBe(false);
    expect(host.querySelector('[data-testid="announcer-polite"]')?.textContent).toBe('Started');
    expect(button(host, 'Run again')?.title).toBe("Send the last run's links again");
    expect(button(host, 'Start')).toBeUndefined();
    // Nothing was released or discarded by the start.
    expect(fake.api.sources.release).not.toHaveBeenCalled();
    expect(fake.api.sources.discardDraft).not.toHaveBeenCalled();
  });

  it('an empty URL field + Enter starts a run, as before', async () => {
    fake.api.settings.hasApiKey = async () => ok(true);
    fake.api.jobs.start = vi.fn(async () => ok({ jobId: 'job-1' })) as unknown as typeof fake.api.jobs.start;
    const { url } = await mount();
    await type(url, 'https://example.com/a');
    await key(url, 'Enter');
    expect(fake.api.jobs.start).not.toHaveBeenCalled();
    await key(url, 'Enter');
    expect(fake.api.jobs.start).toHaveBeenCalledOnce();
  });

  it('sources added while jobs.start is in flight stay as chips', async () => {
    fake.api.settings.hasApiKey = async () => ok(true);
    let finish: (v: ReturnType<typeof ok<{ jobId: string }>>) => void = () => {};
    fake.api.jobs.start = vi.fn(
      () => new Promise<ReturnType<typeof ok<{ jobId: string }>>>((r) => (finish = r)),
    ) as unknown as typeof fake.api.jobs.start;
    const { host, url } = await mount();
    await type(url, 'https://example.com/a');
    await key(url, 'Enter', { metaKey: true });
    expect(fake.api.jobs.start).toHaveBeenCalledOnce();
    await act(async () => {
      window.dispatchEvent(new CustomEvent('eli5:test:drop-paths', { detail: ['/Users/x/later.pdf'] }));
    });
    await flush();
    await act(async () => finish(ok({ jobId: 'job-1' })));
    await flush();
    expect(added(host)).toEqual(['later.pdf']);
    expect(lastRun(host)).toEqual(['example.com/a']);
    // Chips present: the button is Start again, not Run again.
    expect(button(host, 'Start')).toBeDefined();
  });

  it('Run again re-sends the last run with fresh ids; Use again returns it to the chips', async () => {
    fake.api.settings.hasApiKey = async () => ok(true);
    const sent: { inputs: SourceInput[] }[] = [];
    fake.api.jobs.start = vi.fn(async (r) => {
      sent.push(r as never);
      return ok({ jobId: `job-${String(sent.length)}` });
    }) as unknown as typeof fake.api.jobs.start;
    const { host, url } = await mount();
    await type(url, 'https://example.com/a https://example.org/b');
    await click(button(host, 'Start'));
    await new Promise((r) => setTimeout(r, 450)); // past the double-start debounce
    await click(button(host, 'Run again'));
    expect(sent).toHaveLength(2);
    const urls = (r: { inputs: SourceInput[] }) => r.inputs.map((i) => (i.kind === 'url' ? i.url : ''));
    expect(urls(sent[1]!)).toEqual(urls(sent[0]!));
    const ids = (r: { inputs: SourceInput[] }) => r.inputs.map((i) => i.id);
    expect(ids(sent[1]!).some((id) => ids(sent[0]!).includes(id))).toBe(false);
    expect(lastRun(host)).toEqual(['example.com/a', 'example.org/b']);

    await click(button(host, 'Use again'));
    expect(added(host)).toEqual(['example.com/a', 'example.org/b']);
    expect(lastRun(host)).toEqual([]);
    expect(button(host, 'Start')).toBeDefined();
  });

  it('Clear empties the draft including the last run, discards staging and releases files; disabled when empty', async () => {
    const pasted: SourceInput = {
      id: 'in-0000000a',
      kind: 'text',
      origin: 'paste',
      stagedPath: '/tmp/p.txt',
      markup: 'plain',
      preview: 'Pasted text: hi',
    };
    fake.api.sources.readClipboard = async () => ok([pasted]);
    fake.api.settings.hasApiKey = async () => ok(true);
    fake.api.jobs.start = vi.fn(async () => ok({ jobId: 'job-1' })) as unknown as typeof fake.api.jobs.start;
    const { host, url, specifics } = await mount();
    expect(button(host, 'Clear')?.disabled).toBe(true);
    await type(url, 'https://example.com/a');
    await click(button(host, 'Start'));
    expect(lastRun(host)).toEqual(['example.com/a']);
    expect(button(host, 'Clear')?.disabled).toBe(false);
    await act(async () => {
      window.dispatchEvent(new CustomEvent('eli5:test:drop-paths', { detail: ['/Users/x/deck.pptx'] }));
      document.body.dispatchEvent(new Event('paste', { bubbles: true, cancelable: true }));
    });
    await flush();
    await type(specifics, 'pricing');
    await click(button(host, 'Clear'));
    expect(host.querySelectorAll('.chip')).toHaveLength(0);
    expect(url?.value).toBe('');
    expect(specifics?.value).toBe('');
    expect(button(host, 'Clear')?.disabled).toBe(true);
    expect(fake.api.sources.discardDraft).toHaveBeenCalledWith(expect.stringMatching(/^draft-/));
    expect(fake.api.sources.release).toHaveBeenCalledWith([expect.objectContaining({ path: '/Users/x/deck.pptx' })]);
    expect(button(host, 'Start')).toBeDefined();
    expect(document.activeElement).toBe(host.querySelector('.drop-box'));
  });

  it('Clear is disabled while a start is in flight and the programmatic clear does nothing', async () => {
    fake.api.settings.hasApiKey = async () => ok(true);
    let finish: (v: ReturnType<typeof ok<{ jobId: string }>>) => void = () => {};
    fake.api.jobs.start = vi.fn(
      () => new Promise<ReturnType<typeof ok<{ jobId: string }>>>((r) => (finish = r)),
    ) as unknown as typeof fake.api.jobs.start;
    let handle: { clearDraft(): void } | null = null;
    const { host, url } = await mount({ ref: (h: { clearDraft(): void } | null) => (handle = h) });
    await type(url, 'https://example.com/a');
    await click(button(host, 'Start'));
    expect(button(host, 'Clear')?.disabled).toBe(true);
    await act(async () => handle?.clearDraft());
    expect(added(host)).toEqual(['example.com/a']);
    await act(async () => finish(ok({ jobId: 'job-1' })));
    await flush();
    expect(lastRun(host)).toEqual(['example.com/a']);
  });

  it('the Deadpan tab switch sends options.deadpan, stays on after a start and resets on Clear', async () => {
    fake.api.settings.hasApiKey = async () => ok(true);
    const calls: { options: unknown }[] = [];
    fake.api.jobs.start = vi.fn(async (r) => {
      calls.push(r as never);
      return ok({ jobId: `job-${String(calls.length)}` });
    }) as unknown as typeof fake.api.jobs.start;
    const { host, url } = await mount();
    const switches = Array.from(host.querySelectorAll<HTMLInputElement>('input[role="switch"]'));
    // The glossary switch stays first; the Deadpan switch sits with the buttons, before Clear.
    expect(switches).toHaveLength(2);
    const deadpan = switches[1];
    const label = deadpan?.closest('label');
    expect(label?.textContent?.trim()).toBe('Deadpan tab');
    expect(label?.textContent).not.toContain('Start');
    expect(label?.title).toContain('deadpan');
    expect(label?.closest('.input-buttons')).not.toBeNull();
    expect(deadpan?.checked).toBe(false);

    // Off: the request has no deadpan key at all.
    await type(url, 'https://example.com/a');
    await click(button(host, 'Start'));
    expect(calls[0]?.options).toEqual({ clarifyingInput: '', glossary: true });

    await click(deadpan);
    expect(deadpan?.checked).toBe(true);
    await type(url, 'https://example.com/b');
    await new Promise((r) => setTimeout(r, 450)); // past the double-start debounce
    await click(button(host, 'Start'));
    expect(calls).toHaveLength(2);
    expect(calls[1]?.options).toEqual({ clarifyingInput: '', glossary: true, deadpan: true });
    // Kept after a start in the same session.
    expect(deadpan?.checked).toBe(true);

    await click(button(host, 'Clear'));
    expect(host.querySelectorAll<HTMLInputElement>('input[role="switch"]')[1]?.checked).toBe(false);
  });

  it('Enter on the Deadpan switch starts like the other switch', async () => {
    fake.api.settings.hasApiKey = async () => ok(true);
    fake.api.jobs.start = vi.fn(async () => ok({ jobId: 'job-1' })) as unknown as typeof fake.api.jobs.start;
    const { host, url } = await mount();
    await type(url, 'https://example.com/a');
    await key(url, 'Enter');
    await key(host.querySelectorAll('input[role="switch"]')[1], 'Enter');
    expect(fake.api.jobs.start).toHaveBeenCalledOnce();
  });

  it('URL chips copy the full URL: Cmd+C on a focused chip and the icon-only copy button', async () => {
    const { host, url } = await mount();
    const long = 'https://example.com/a/very/long/path?with=query&and=more';
    await type(url, long);
    await key(url, 'Enter');
    const chip = host.querySelector<HTMLElement>('ul[aria-label="Added sources"] .chip')!;
    // Cmd+C reaches the focused chip as a copy event (the Edit menu's copy role).
    const data = new Map<string, string>();
    const ev = new Event('copy', { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown };
    ev.clipboardData = { setData: (t: string, v: string) => data.set(t, v), getData: () => '' };
    await act(async () => chip.dispatchEvent(ev));
    expect(ev.defaultPrevented).toBe(true);
    expect(data.get('text/plain')).toBe(long);
    // The icon button copies through a one-shot copy handler.
    document.execCommand = vi.fn(() => {
      const e = new Event('copy', { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown };
      e.clipboardData = { setData: (t: string, v: string) => data.set(`button:${t}`, v), getData: () => '' };
      document.dispatchEvent(e);
      return true;
    });
    await click(button(host, 'Copy example.com/a/very/long/path?with=query&and=more'));
    expect(data.get('button:text/plain')).toBe(long);
  });

  it('removing a file chip releases its registration unless another chip names the same file', async () => {
    const { host } = await mount();
    await act(async () => {
      window.dispatchEvent(new CustomEvent('eli5:test:drop-paths', { detail: ['/Users/x/a.pdf', '/Users/x/a.pdf'] }));
    });
    await flush();
    const removers = () => host.querySelectorAll<HTMLButtonElement>('.chip-remove');
    await click(removers()[0]!);
    expect(fake.api.sources.release).not.toHaveBeenCalled();
    await click(removers()[0]!);
    expect(fake.api.sources.release).toHaveBeenCalledWith([expect.objectContaining({ path: '/Users/x/a.pdf' })]);
  });

  it('Shift+Enter in specifics does not start', async () => {
    const { specifics } = await mount();
    await key(specifics, 'Enter', { shiftKey: true });
    expect(fake.api.settings.hasApiKey).not.toHaveBeenCalled();
  });

  it('paste outside text fields asks main for clipboard sources', async () => {
    const pasted: SourceInput = {
      id: 'in-0000000a',
      kind: 'image',
      origin: 'paste',
      stagedPath: '/tmp/p.png',
      mediaType: 'image/png',
      preview: 'Pasted image 14:02',
    };
    fake.api.sources.readClipboard = async () => ok([pasted]);
    const { host } = await mount();
    await act(async () => {
      document.body.dispatchEvent(new Event('paste', { bubbles: true, cancelable: true }));
    });
    await flush();
    expect(host.textContent).toContain('Pasted image 14:02');

    // Removing a staged paste discards it in main.
    await click(button(host, 'Remove Pasted image 14:02'));
    expect(fake.api.sources.discard).toHaveBeenCalledWith(expect.stringMatching(/^draft-/), 'in-0000000a');
  });

  it('an empty clipboard shows "Nothing to paste"', async () => {
    fake.api.sources.readClipboard = async () => ok([]);
    const { host } = await mount();
    await act(async () => {
      document.body.dispatchEvent(new Event('paste', { bubbles: true, cancelable: true }));
    });
    await flush();
    expect(host.textContent).toContain('Nothing to paste');
  });

  it('pasting several URLs into the URL field commits each as a chip', async () => {
    const { host, url } = await mount();
    const ev = new Event('paste', { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown };
    ev.clipboardData = { getData: () => 'https://example.com/a https://example.org/b oops' };
    await act(async () => {
      url?.dispatchEvent(ev);
    });
    await flush();
    expect(host.querySelectorAll('.chip')).toHaveLength(2);
    expect(url?.value).toBe('oops');
    expect(host.textContent).toContain('Enter a web address');
  });

  it('has no microphone control (11 §1)', async () => {
    const { host } = await mount();
    expect(host.innerHTML.toLowerCase()).not.toMatch(/microphone|dictat|record/);
  });
});
