/**
 * Primary desktop (16 §4.6). Exactly one desktop writes the library mirror. A claim is an immutable
 * `claim-<ms>-<deviceId>.json`; the newest claim (`ms`, then `deviceId` as tie-break) names the
 * primary. A device that has just claimed waits until the previous primary acknowledges (its device
 * file shows `role: 'mirror'`) or has been silent for 15 minutes, and only then pushes. Every step
 * writes only files the writing device owns.
 *
 * The claim time travels in the file's `n` property, so deciding never downloads a claim body.
 */
import type { RemoteFile } from './types';
import type { Claim, DeviceRecord } from './protocol';

/** A previous primary silent this long is treated as gone (16 §4.6). */
export const TAKEOVER_SILENCE_MS = 15 * 60 * 1000;

export interface ClaimRef {
  fileId: string;
  deviceId: string;
  /** Epoch ms of the claim. */
  ms: number;
}

/** What the store says about one device, for the takeover check. */
export interface DeviceView {
  role?: DeviceRecord['role'];
  /** Last heartbeat, epoch ms (the `seen` property, else the file's modifiedTime). */
  seenMs?: number;
}

export type ClaimRole =
  /** This device holds the newest claim and may write. */
  | { role: 'primary' }
  /** Another device holds the newest claim (or none exists yet): show status only. */
  | { role: 'mirror'; primary?: string }
  /** This device holds the newest claim but the previous primary has not let go yet. */
  | { role: 'waiting'; previous: string };

export function claimName(ms: number, deviceId: string): string {
  return `claim-${ms}-${deviceId}.json`;
}

export function claimBody(ms: number, deviceId: string): Claim {
  return { deviceId, claimedAt: new Date(ms).toISOString() };
}

/** Claim files as refs; a file without a usable `n` is ignored (it cannot be ordered). */
export function claimRefs(files: Iterable<RemoteFile>): ClaimRef[] {
  const out: ClaimRef[] = [];
  for (const f of files) {
    if (f.props.k !== 'claim' || f.props.n === undefined) continue;
    out.push({ fileId: f.id, deviceId: f.props.dev, ms: f.props.n });
  }
  return out;
}

/** Newest first: by `ms`, then by `deviceId` (the larger id wins a tie), then file id. */
export function compareClaims(a: ClaimRef, b: ClaimRef): number {
  if (a.ms !== b.ms) return b.ms - a.ms;
  if (a.deviceId !== b.deviceId) return a.deviceId < b.deviceId ? 1 : -1;
  return a.fileId < b.fileId ? 1 : a.fileId > b.fileId ? -1 : 0;
}

export function newestClaim(claims: readonly ClaimRef[]): ClaimRef | undefined {
  return [...claims].sort(compareClaims)[0];
}

/** The `ms` for a new claim that is newer than every existing one. */
export function nextClaimMs(claims: readonly ClaimRef[], now: number): number {
  const newest = newestClaim(claims);
  return newest && newest.ms >= now ? newest.ms + 1 : now;
}

/**
 * This device's role (16 §4.6). `devices` maps device ids to what their device files say.
 */
export function decideRole(p: {
  me: string;
  claims: readonly ClaimRef[];
  devices: ReadonlyMap<string, DeviceView>;
  now: number;
}): ClaimRole {
  const sorted = [...p.claims].sort(compareClaims);
  const newest = sorted[0];
  if (!newest) return { role: 'mirror' };
  if (newest.deviceId !== p.me) return { role: 'mirror', primary: newest.deviceId };
  // The previous primary: the newest claim by another device (older than ours by ordering).
  const previous = sorted.find((c) => c.deviceId !== p.me);
  if (!previous) return { role: 'primary' };
  // Wait for the previous claim holder, and for any other older claimer whose device file still says
  // `primary` (it may not have seen the newer claims yet), until each acknowledges or goes silent.
  const checked = new Set<string>();
  for (const c of sorted) {
    if (c.deviceId === p.me || checked.has(c.deviceId)) continue;
    checked.add(c.deviceId);
    const dev = p.devices.get(c.deviceId);
    if (dev?.role === 'mirror' || dev?.role === 'phone') continue;
    if (c.deviceId !== previous.deviceId && dev?.role !== 'primary') continue;
    // Silent since: its last heartbeat, or its claim if it never wrote a device file.
    const lastHeard = Math.max(dev?.seenMs ?? 0, dev ? 0 : c.ms);
    if (p.now - lastHeard < TAKEOVER_SILENCE_MS) return { role: 'waiting', previous: c.deviceId };
  }
  return { role: 'primary' };
}

/** Claims older than the newest one: garbage once the newest holder is primary (16 §4.7). */
export function staleClaims(claims: readonly ClaimRef[]): ClaimRef[] {
  return [...claims].sort(compareClaims).slice(1);
}
