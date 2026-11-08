import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SyncStatus } from '../../../../src/preload/contract';
import { click, installFakeApi, loadRenderer, ok, render, syncStatus, type Component, type FakeApi } from '../harness';

/** Sidebar footer sync indicator (11 §7 "Sync indicator", 16 §8) and its text helpers. */

const { SyncIndicator } = await loadRenderer<{ SyncIndicator: Component }>('sync/SyncIndicator.tsx');
const view = await loadRenderer<{
  indicatorState(s: SyncStatus | null): string | null;
  indicatorLabel(s: SyncStatus): string;
  lastSyncedText(iso: string | undefined, now?: number): string;
  pendingText(n: number): string | null;
}>('sync/sync-view.ts');

let fake: FakeApi;
beforeEach(() => {
  fake = installFakeApi();
});

const indicator = (host: HTMLElement) => host.querySelector<HTMLButtonElement>('.sync-indicator');

describe('SyncIndicator', () => {
  it('is absent while sync is off', async () => {
    const host = await render(SyncIndicator, { onOpen: () => {} });
    expect(indicator(host)).toBeNull();
  });

  it('is absent when the policy does not allow sync', async () => {
    vi.mocked(fake.api.sync.status).mockResolvedValue({
      ok: false,
      error: { code: 'E_NOT_AVAILABLE_IN_EDITION', message: 'Not available in this edition' },
    });
    const host = await render(SyncIndicator, { onOpen: () => {} });
    expect(indicator(host)).toBeNull();
  });

  it('shows synced, syncing and problem from status events, and opens Settings > Sync', async () => {
    vi.mocked(fake.api.sync.status).mockResolvedValue(
      ok(syncStatus({ state: 'idle', configured: true, signedIn: true })),
    );
    const onOpen = vi.fn();
    const host = await render(SyncIndicator, { onOpen });
    expect(indicator(host)?.dataset.state).toBe('synced');
    expect(indicator(host)?.getAttribute('aria-label')).toBe('Sync: up to date');
    fake.emit('sync', syncStatus({ state: 'syncing', signedIn: true }));
    expect(indicator(host)?.dataset.state).toBe('syncing');
    fake.emit('sync', syncStatus({ state: 'error', signedIn: true, message: 'Your Google Drive is full' }));
    expect(indicator(host)?.dataset.state).toBe('problem');
    expect(indicator(host)?.getAttribute('aria-label')).toBe('Sync: Your Google Drive is full');
    await click(indicator(host));
    expect(onOpen).toHaveBeenCalledOnce();
    fake.emit('sync', syncStatus({ state: 'off' }));
    expect(indicator(host)).toBeNull();
  });
});

describe('sync-view helpers', () => {
  it('maps every state to one of three indicator states, or none when off', () => {
    const map = (state: SyncStatus['state']) => view.indicatorState(syncStatus({ state }));
    expect(map('off')).toBeNull();
    expect(view.indicatorState(null)).toBeNull();
    expect(map('idle')).toBe('synced');
    expect(map('mirror')).toBe('synced');
    expect(map('syncing')).toBe('syncing');
    for (const s of ['error', 'signed-out', 'not-configured', 'paused-read-only'] as const)
      expect(map(s)).toBe('problem');
    expect(view.indicatorLabel(syncStatus({ state: 'idle', pendingUploads: 1 }))).toBe('Sync: changes waiting');
    expect(view.indicatorLabel(syncStatus({ state: 'signed-out' }))).toBe('Sync: not connected to Google Drive');
  });

  it('formats last synced and pending uploads', () => {
    const now = Date.parse('2026-11-07T12:00:00Z');
    expect(view.lastSyncedText(undefined, now)).toBe('Not synced yet');
    expect(view.lastSyncedText('2026-11-07T11:59:50Z', now)).toBe('Last synced just now');
    expect(view.lastSyncedText('2026-11-07T09:00:00Z', now)).toBe('Last synced 3h ago');
    expect(view.pendingText(0)).toBeNull();
    expect(view.pendingText(1)).toBe('1 document waiting to upload');
    expect(view.pendingText(3)).toBe('3 documents waiting to upload');
  });
});
