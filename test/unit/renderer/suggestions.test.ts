import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcResult, MergeSuggestion } from '../../../src/preload/contract';
import {
  button,
  click,
  flush,
  installFakeApi,
  loadRenderer,
  ok,
  render,
  type Component,
  type FakeApi,
} from './harness';

/** Suggestions area (11 §5.6, 09 §10.4): copy, states, and non-blocking behavior. */

const { SuggestionsPanel } = await loadRenderer<{ SuggestionsPanel: Component }>('suggestions/SuggestionsPanel.tsx');
const { AnnouncerProvider } = await loadRenderer<{ AnnouncerProvider: Component }>('a11y/Announcer.tsx');

let fake: FakeApi;
beforeEach(() => {
  fake = installFakeApi();
});

const Panel = (props: Record<string, unknown>) =>
  createElement(AnnouncerProvider, null, createElement(SuggestionsPanel, props));

const suggestion = (over: Partial<MergeSuggestion> = {}): MergeSuggestion => ({
  id: 's1',
  createdAt: '2026-01-01T00:00:00Z',
  status: 'pending',
  source: { id: 'n', slug: 'widget-roas', title: 'Widget ROAS' },
  target: { id: 't', slug: 'widget-ad-spend', title: 'Widget ad spend' },
  score: 0.9,
  reason: 'Both explain return on ad spend.',
  scorer: 'lexical+llm',
  ...over,
});

const fail = (message: string): IpcResult<never> => ({ ok: false, error: { code: 'E_MERGE_FAILED', message } });

describe('SuggestionsPanel copy and states (09 §10.4)', () => {
  it('bolds the target title, shows the reason as secondary text and the new document', async () => {
    fake.api.suggestions.list = async () => ok([suggestion()]);
    const host = await render(Panel, { onOpenDoc: vi.fn() });
    expect(host.querySelector('strong')?.textContent).toBe('Widget ad spend');
    expect(host.textContent).toContain('This looks related to Widget ad spend. Merge it in or keep it separate?');
    expect(host.textContent).toContain('Both explain return on ad spend.');
    expect(host.textContent).toContain('Widget ROAS');
    expect(host.querySelector('section')?.getAttribute('aria-labelledby')).toBe('suggestions-title');
    expect(host.querySelector('[role="dialog"], dialog')).toBeNull();
  });

  it('shows lastError beneath a pending suggestion and offers Try again', async () => {
    fake.api.suggestions.list = async () =>
      ok([suggestion({ lastError: 'Merge failed. Both documents were left unchanged.' })]);
    const host = await render(Panel, { onOpenDoc: vi.fn() });
    expect(host.textContent).toContain('Merge failed. Both documents were left unchanged.');
    expect(button(host, 'Merge in')).toBeUndefined();
    expect(button(host, 'Try again')?.disabled).toBe(false);
    expect(host.querySelector('[role="dialog"], dialog')).toBeNull();
  });

  it('shows "Merging…" with both buttons disabled while accepting', async () => {
    fake.api.suggestions.list = async () => ok([suggestion({ status: 'accepting' })]);
    const host = await render(Panel, { onOpenDoc: vi.fn() });
    expect(host.textContent).toContain('Merging…');
    expect(button(host, 'Merge in')?.disabled).toBe(true);
    expect(button(host, 'Keep separate')?.disabled).toBe(true);
  });

  it('while an accept is in flight, disables the buttons until the list changes', async () => {
    fake.api.suggestions.list = async () => ok([suggestion()]);
    let resolve!: (r: IpcResult<{ targetSlug: string }>) => void;
    fake.api.suggestions.accept = vi.fn(
      () => new Promise<IpcResult<{ targetSlug: string }>>((r) => (resolve = r)),
    ) as typeof fake.api.suggestions.accept;
    const host = await render(Panel, { onOpenDoc: vi.fn() });
    await click(button(host, 'Merge in'));
    expect(host.textContent).toContain('Merging…');
    expect(button(host, 'Keep separate')?.disabled).toBe(true);
    fake.emit('suggestions', { suggestions: [] });
    resolve(ok({ targetSlug: 'widget-ad-spend' }));
    await flush();
    expect(host.textContent).not.toContain('Suggestions');
  });

  it('opens the target after an accept when the merged-away document is the one on screen', async () => {
    fake.api.suggestions.list = async () => ok([suggestion()]);
    fake.api.suggestions.accept = vi.fn(async () => ok({ targetSlug: 'widget-ad-spend' }));
    const onOpenDoc = vi.fn();
    const host = await render(Panel, { onOpenDoc, currentSlug: 'widget-roas' });
    await click(button(host, 'Merge in'));
    expect(onOpenDoc).toHaveBeenCalledWith('widget-ad-spend');
  });

  it('does not navigate when another document is on screen', async () => {
    fake.api.suggestions.list = async () => ok([suggestion()]);
    fake.api.suggestions.accept = vi.fn(async () => ok({ targetSlug: 'widget-ad-spend' }));
    const onOpenDoc = vi.fn();
    const host = await render(Panel, { onOpenDoc, currentSlug: 'office-plants' });
    await click(button(host, 'Merge in'));
    expect(onOpenDoc).not.toHaveBeenCalled();
  });

  it('shows an accept error inline once, and prefers lastError from the list', async () => {
    fake.api.suggestions.list = async () => ok([suggestion()]);
    fake.api.suggestions.accept = vi.fn(async () => fail('The documents could not be merged'));
    const host = await render(Panel, { onOpenDoc: vi.fn() });
    await click(button(host, 'Merge in'));
    expect(host.textContent).toContain('The documents could not be merged');
    expect(button(host, 'Try again')?.disabled).toBe(false);
    fake.emit('suggestions', {
      suggestions: [suggestion({ lastError: 'Merge failed. Both documents were left unchanged.' })],
    });
    await flush();
    expect(host.textContent).toContain('Merge failed. Both documents were left unchanged.');
    expect(host.textContent).not.toContain('The documents could not be merged');
  });

  it('keeps focus where it was when a suggestion arrives and announces it politely once', async () => {
    const host = await render(Panel, { onOpenDoc: vi.fn() });
    const input = document.createElement('input');
    document.body.append(input);
    input.focus();
    fake.emit('suggestions', { suggestions: [suggestion()] });
    await flush();
    expect(document.activeElement).toBe(input);
    expect(host.querySelector('[data-testid="announcer-polite"]')?.textContent).toBe('New suggestion');
    input.remove();
  });
});
