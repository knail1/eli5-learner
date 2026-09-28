// SectionId and tab-key rules (07 §3, §4). Pure apart from the default crypto IdSource.
import { randomBytes } from 'node:crypto';
import type { SectionId } from '../../preload/contract';
import type { FixedTabKey } from './types';

/** 07 §3: `sec-<tabKey>-<8 lowercase hex>`. The one source of this pattern (08 §3, 13 §7). */
export const SECTION_ID_RE = /^sec-[a-z][a-z0-9]{1,15}-[0-9a-f]{8}$/;

/** 07 §4.1: 'indepth' | 'eli5' | 'sx' + 6 lowercase hex. */
export const TAB_KEY_RE = /^(?:indepth|eli5|sx[0-9a-f]{6})$/;
export const SECTION_ELI5_TAB_KEY_RE = /^sx[0-9a-f]{6}$/;

export const INDEPTH_TAB_KEY: FixedTabKey = 'indepth';
export const ELI5_TAB_KEY: FixedTabKey = 'eli5';

/** Max draws before giving up (07 §4.2 rule 2). */
export const MAX_ID_DRAWS = 8;

/** Injectable randomness (13 §2: constructor-injected; SeededIdSource in tests). */
export interface IdSource {
  /** Returns exactly `chars` lowercase hex characters. */
  hex(chars: number): string;
}

/** Production source: crypto.randomBytes (07 §4.2 rule 2). */
export const cryptoIdSource: IdSource = {
  hex(chars: number): string {
    return randomBytes(Math.ceil(chars / 2))
      .toString('hex')
      .slice(0, chars);
  },
};

/** Thrown when MAX_ID_DRAWS draws all collide (07 §4.2 rule 2). */
export class IdExhaustedError extends Error {
  constructor(readonly prefix: string) {
    super(`Could not mint a unique id with prefix "${prefix}" after ${MAX_ID_DRAWS} draws`);
    this.name = 'IdExhaustedError';
  }
}

/** A set-like collection of ids already used anywhere in the document, including retired ones (07 §4.3). */
export interface TakenIds {
  has(id: string): boolean;
}

export function isSectionId(v: unknown): v is SectionId {
  return typeof v === 'string' && SECTION_ID_RE.test(v);
}

export function isTabKey(v: unknown): v is string {
  return typeof v === 'string' && TAB_KEY_RE.test(v);
}

export function isSectionEli5TabKey(v: unknown): v is string {
  return typeof v === 'string' && SECTION_ELI5_TAB_KEY_RE.test(v);
}

/** The tab key segment of a SectionId (08 §3: must equal the request's tabKey). */
export function tabKeyOfSectionId(id: SectionId): string {
  return id.slice(4, id.lastIndexOf('-'));
}

const HEX_RE = /^[0-9a-f]+$/;

function draw(src: IdSource, chars: number): string {
  const h = src.hex(chars);
  if (h.length !== chars || !HEX_RE.test(h)) {
    throw new Error(`IdSource returned "${h}", expected ${chars} lowercase hex chars`);
  }
  return h;
}

/** `prefix` + `chars` hex, redrawn on collision with `taken` (07 §4.2 rule 2). */
export function mintWithPrefix(prefix: string, chars: number, src: IdSource, taken: TakenIds): string {
  for (let i = 0; i < MAX_ID_DRAWS; i++) {
    const id = prefix + draw(src, chars);
    if (!taken.has(id)) return id;
  }
  throw new IdExhaustedError(prefix);
}

/**
 * Mint a fresh SectionId under `tabKey` (07 §4.2). `taken` must hold every ID in the document
 * (all tabs) plus retired IDs, so an ID is never reused. The caller adds the result to `taken`.
 */
export function mintSectionId(tabKey: string, idSource: IdSource, taken: TakenIds): SectionId {
  if (!isTabKey(tabKey)) throw new Error(`Invalid tab key "${tabKey}"`);
  return mintWithPrefix(`sec-${tabKey}-`, 8, idSource, taken) as SectionId;
}

/** Mint a section ELI5 tab key `sx` + 6 hex (07 §4.1), unique against `taken` tab keys. */
export function mintSectionEli5TabKey(idSource: IdSource, taken: TakenIds): string {
  return mintWithPrefix('sx', 6, idSource, taken);
}
