/** Primary desktop claims and takeover (16 §4.6). */
import { describe, expect, it } from 'vitest';
import {
  TAKEOVER_SILENCE_MS,
  claimName,
  claimRefs,
  compareClaims,
  decideRole,
  newestClaim,
  nextClaimMs,
  staleClaims,
  type ClaimRef,
  type DeviceView,
} from '../../../../src/main/sync';

const A = '0b7c5e2a-1f3d-4c4e-9a8b-2d6f0e1c3b5a';
const B = '1c8d6f3b-2a4e-4d5f-8b9c-3e7a1f2d4c6b';
const NOW = Date.parse('2026-11-01T12:00:00Z');
const c = (deviceId: string, ms: number, fileId = `c-${deviceId.slice(0, 4)}-${ms}`): ClaimRef => ({
  fileId,
  deviceId,
  ms,
});

describe('claims (16 §4.6)', () => {
  it('names claim files claim-<ms>-<deviceId>.json and reads ms from the n property', () => {
    expect(claimName(1700, A)).toBe(`claim-1700-${A}.json`);
    const refs = claimRefs([
      { id: 'x', name: 'claim', props: { k: 'claim', dev: A, n: 5 } },
      { id: 'y', name: 'claim', props: { k: 'claim', dev: B } }, // no n: cannot be ordered, ignored
      { id: 'z', name: 'device', props: { k: 'device', dev: B } },
    ]);
    expect(refs).toEqual([{ fileId: 'x', deviceId: A, ms: 5 }]);
  });

  it('orders by ms, then device id as tie-break', () => {
    expect(newestClaim([c(A, 10), c(B, 9)])!.deviceId).toBe(A);
    expect(newestClaim([c(A, 10), c(B, 10)])!.deviceId).toBe(B); // B > A
    expect([c(A, 1), c(B, 3), c(A, 2)].sort(compareClaims).map((x) => x.ms)).toEqual([3, 2, 1]);
  });

  it('a new claim is newer than every existing one, even when the clock lags', () => {
    expect(nextClaimMs([], NOW)).toBe(NOW);
    expect(nextClaimMs([c(A, NOW + 5000)], NOW)).toBe(NOW + 5001);
  });

  it('no claim yet: mirror until this device claims', () => {
    expect(decideRole({ me: A, claims: [], devices: new Map(), now: NOW })).toEqual({ role: 'mirror' });
  });

  it('the newest claim by another device makes this one a mirror', () => {
    expect(decideRole({ me: A, claims: [c(A, 1), c(B, 2)], devices: new Map(), now: NOW })).toEqual({
      role: 'mirror',
      primary: B,
    });
  });

  it('the only claimant is primary', () => {
    expect(decideRole({ me: A, claims: [c(A, 1), c(A, 2)], devices: new Map(), now: NOW })).toEqual({
      role: 'primary',
    });
  });

  it('a takeover waits for the old primary to acknowledge or fall silent for 15 minutes', () => {
    const claims = [c(B, NOW - 60_000), c(A, NOW - 1000)];
    const live = new Map<string, DeviceView>([[B, { role: 'primary', seenMs: NOW - 60_000 }]]);
    expect(decideRole({ me: A, claims, devices: live, now: NOW })).toEqual({ role: 'waiting', previous: B });
    const acked = new Map<string, DeviceView>([[B, { role: 'mirror', seenMs: NOW - 60_000 }]]);
    expect(decideRole({ me: A, claims, devices: acked, now: NOW })).toEqual({ role: 'primary' });
    expect(decideRole({ me: A, claims, devices: live, now: NOW - 60_000 + TAKEOVER_SILENCE_MS })).toEqual({
      role: 'primary',
    });
    // An old primary that never wrote a device file is judged by its claim time.
    expect(decideRole({ me: A, claims, devices: new Map(), now: NOW })).toEqual({ role: 'waiting', previous: B });
    expect(decideRole({ me: A, claims, devices: new Map(), now: NOW + TAKEOVER_SILENCE_MS })).toEqual({
      role: 'primary',
    });
  });

  it('also waits for an older claimer that still says primary, not only the previous claim holder', () => {
    const C = '2d9e7a4c-3b5f-4e6a-9c0d-4f8b2a3e5d7c';
    // A was primary; B claimed and is waiting (says mirror); C claims newest. A has not seen either yet.
    const claims = [c(A, NOW - 120_000), c(B, NOW - 60_000), c(C, NOW - 1000)];
    const devices = new Map<string, DeviceView>([
      [A, { role: 'primary', seenMs: NOW - 30_000 }],
      [B, { role: 'mirror', seenMs: NOW - 30_000 }],
    ]);
    expect(decideRole({ me: C, claims, devices, now: NOW })).toEqual({ role: 'waiting', previous: A });
    devices.set(A, { role: 'mirror', seenMs: NOW });
    expect(decideRole({ me: C, claims, devices, now: NOW })).toEqual({ role: 'primary' });
    // An older claimer without a device file that is not the previous holder never blocks.
    devices.delete(A);
    expect(decideRole({ me: C, claims, devices, now: NOW })).toEqual({ role: 'primary' });
  });

  it('every claim but the newest is stale', () => {
    expect(staleClaims([c(A, 1), c(B, 3), c(A, 2)]).map((x) => x.ms)).toEqual([2, 1]);
  });
});
