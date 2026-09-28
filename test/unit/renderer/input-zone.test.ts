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
    await key(url, 'Enter');
    expect(host.textContent).toContain('Add an API key in Settings to start');
    expect(fake.api.jobs.start).not.toHaveBeenCalled();
    await click(button(host, 'Open Settings'));
    expect(opened).toBe(1);
  });

  it('combines URL, dropped files and specifics into one start request, then clears the draft', async () => {
    fake.api.settings.hasApiKey = async () => ok(true);
    fake.api.jobs.start = async () => ok({ jobId: 'job-1' });
    const calls: unknown[] = [];
    const start = fake.api.jobs.start;
    fake.api.jobs.start = async (r) => {
      calls.push(r);
      return start(r);
    };
    const { host, url, specifics } = await mount();
    await act(async () => {
      window.dispatchEvent(new CustomEvent('eli5:test:drop-paths', { detail: ['/Users/x/quarterly-review.pptx'] }));
    });
    await flush();
    await type(url, 'https://example.com/a https://example.org/b');
    await type(specifics, 'Focus on pricing');
    await click(host.querySelector('input[role="switch"]'));
    await key(url, 'Enter');

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

    // Draft cleared, glossary back to default, "Started" announced, focus on the drop box.
    expect(host.querySelectorAll('.chip')).toHaveLength(0);
    expect(url?.value).toBe('');
    expect(specifics?.value).toBe('');
    expect(host.querySelector<HTMLInputElement>('input[role="switch"]')?.checked).toBe(true);
    expect(host.querySelector('[data-testid="announcer-polite"]')?.textContent).toBe('Started');
    expect(document.activeElement).toBe(host.querySelector('.drop-box'));
  });

  it('an error from main keeps the draft and shows the message inline', async () => {
    fake.api.settings.hasApiKey = async () => ok(true);
    const { host, url } = await mount();
    await type(url, 'https://example.com/a');
    await click(button(host, 'Start'));
    expect(host.textContent).toContain('Not implemented yet');
    expect(host.querySelectorAll('.chip')).toHaveLength(1);
  });

  it('a second Enter while the key check is pending does not start a second job', async () => {
    let release: (v: ReturnType<typeof ok<boolean>>) => void = () => {};
    fake.api.settings.hasApiKey = vi.fn(
      () => new Promise<ReturnType<typeof ok<boolean>>>((r) => (release = r)),
    ) as unknown as typeof fake.api.settings.hasApiKey;
    const { url } = await mount();
    await type(url, 'https://example.com/a');
    await key(url, 'Enter');
    await key(url, 'Enter');
    await act(async () => release(ok(true)));
    await flush();
    expect(fake.api.settings.hasApiKey).toHaveBeenCalledOnce();
    expect(fake.api.jobs.start).toHaveBeenCalledOnce();
  });

  it('sources added while jobs.start is in flight survive the post-start clear', async () => {
    fake.api.settings.hasApiKey = async () => ok(true);
    let finish: (v: ReturnType<typeof ok<{ jobId: string }>>) => void = () => {};
    fake.api.jobs.start = vi.fn(
      () => new Promise<ReturnType<typeof ok<{ jobId: string }>>>((r) => (finish = r)),
    ) as unknown as typeof fake.api.jobs.start;
    const { host, url } = await mount();
    await type(url, 'https://example.com/a');
    await key(url, 'Enter');
    expect(fake.api.jobs.start).toHaveBeenCalledOnce();
    await act(async () => {
      window.dispatchEvent(new CustomEvent('eli5:test:drop-paths', { detail: ['/Users/x/later.pdf'] }));
    });
    await flush();
    await act(async () => finish(ok({ jobId: 'job-1' })));
    await flush();
    const chips = Array.from(host.querySelectorAll('.chip')).map((c) => c.textContent ?? '');
    expect(chips).toHaveLength(1);
    expect(chips[0]).toContain('later.pdf');
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
