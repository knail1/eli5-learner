import { describe, expect, it } from 'vitest';
import { MENU_SHORTCUT_KEYS, type MenuShortcutId } from '../../../src/main/shell/app-menu';
import { loadRenderer } from './harness';

type Key = { key: string; code?: string; metaKey: boolean; shiftKey: boolean; ctrlKey: boolean; altKey: boolean };
type ShortcutId = string;
const { SHORTCUTS, matchShortcut } = await loadRenderer<{
  SHORTCUTS: readonly { id: ShortcutId }[];
  matchShortcut(k: Key): { id: ShortcutId; index?: number } | null;
}>('a11y/shortcuts.ts');

/**
 * The application menu forwards its window-shortcut items to the app renderer as Cmd+<key>
 * (src/main/shell/app-menu.ts MENU_SHORTCUT_KEYS, 11 §9). The renderer table must map each of
 * those keys back to the same action, whatever case Electron reports the key in.
 */

const key = (k: string, mods: Partial<{ meta: boolean; shift: boolean; ctrl: boolean; alt: boolean }> = {}): Key => ({
  key: k,
  metaKey: mods.meta ?? true,
  shiftKey: mods.shift ?? false,
  ctrlKey: mods.ctrl ?? false,
  altKey: mods.alt ?? false,
});

describe('window shortcuts mirrored by the application menu (11 §9)', () => {
  const forwarded: [string, ShortcutId][] = [
    ['N', 'new-draft'],
    ['L', 'focus-url'],
    ['\\', 'toggle-sidebar'],
    ['[', 'prev-doc'],
    [']', 'next-doc'],
  ];

  it.each(forwarded)('Cmd+%s maps to %s in either case', (k, id) => {
    expect(matchShortcut(key(k))?.id).toBe(id);
    expect(matchShortcut(key(k.toLowerCase()))?.id).toBe(id);
  });

  it('covers exactly the keys the menu forwards', () => {
    const menu = Object.entries(MENU_SHORTCUT_KEYS) as [MenuShortcutId, string][];
    expect(menu.map(([id, k]) => [k, id]).sort()).toEqual([...forwarded].sort());
  });

  it('Cmd+, opens Settings and Cmd+1…9 open the nth document', () => {
    expect(matchShortcut(key(','))).toEqual({ id: 'settings' });
    expect(matchShortcut(key('1'))).toEqual({ id: 'nth-doc', index: 0 });
    expect(matchShortcut(key('9'))).toEqual({ id: 'nth-doc', index: 8 });
    expect(matchShortcut(key('0'))).toBeNull();
  });

  it('Cmd+F finds in the document, Cmd+G / Shift+Cmd+G step, Option+Cmd+F focuses the Library filter', () => {
    expect(matchShortcut(key('f'))).toEqual({ id: 'find' });
    expect(matchShortcut(key('F'))).toEqual({ id: 'find' });
    expect(matchShortcut(key('g'))).toEqual({ id: 'find-next' });
    expect(matchShortcut(key('G', { shift: true }))).toEqual({ id: 'find-previous' });
    expect(matchShortcut(key('g', { shift: true }))).toEqual({ id: 'find-previous' });
    // Option turns F into ƒ on a US layout; the physical key still counts.
    expect(matchShortcut({ ...key('ƒ', { alt: true }), code: 'KeyF' })).toEqual({ id: 'focus-filter' });
    expect(matchShortcut(key('f', { alt: true }))).toEqual({ id: 'focus-filter' });
    expect(matchShortcut(key('f', { alt: true, shift: true }))).toBeNull();
    expect(matchShortcut(key('f', { shift: true }))).toBeNull();
    expect(matchShortcut(key('g', { alt: true }))).toBeNull();
  });

  it('F6 and Shift+F6 cycle focus regions without Cmd', () => {
    expect(matchShortcut(key('F6', { meta: false }))).toEqual({ id: 'next-region' });
    expect(matchShortcut(key('F6', { meta: false, shift: true }))).toEqual({ id: 'prev-region' });
  });

  it('Cmd+R, Cmd+W and Cmd+Q are left to the application menu (reload viewer, hide window)', () => {
    for (const k of ['r', 'w', 'q']) expect(matchShortcut(key(k)), k).toBeNull();
  });

  it('ignores the keys with extra modifiers or without Cmd', () => {
    expect(matchShortcut(key('l', { meta: false }))).toBeNull();
    expect(matchShortcut(key('l', { shift: true }))).toBeNull();
    expect(matchShortcut(key('l', { alt: true }))).toBeNull();
    expect(matchShortcut(key('l', { ctrl: true }))).toBeNull();
  });

  it('lists every action once in the shortcut table', () => {
    const ids = SHORTCUTS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
