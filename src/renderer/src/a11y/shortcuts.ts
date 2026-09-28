/**
 * Window shortcuts (11 §9), defined once. Cmd+W / Cmd+Q / Cmd+, are also application menu
 * accelerators in main; the menu handles those before the renderer sees them.
 */

export type ShortcutId =
  | 'focus-url'
  | 'new-draft'
  | 'settings'
  | 'toggle-sidebar'
  | 'focus-filter'
  | 'prev-doc'
  | 'next-doc'
  | 'nth-doc'
  | 'next-region'
  | 'prev-region';

export interface KeyLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export interface ShortcutMatch {
  id: ShortcutId;
  /** 0-based index for nth-doc. */
  index?: number;
}

export const SHORTCUTS: readonly { keys: string; id: ShortcutId; label: string }[] = [
  { keys: 'Cmd+L', id: 'focus-url', label: 'Focus URL field' },
  { keys: 'Cmd+N', id: 'new-draft', label: 'Focus drop box and clear the draft' },
  { keys: 'Cmd+,', id: 'settings', label: 'Open Settings' },
  { keys: 'Cmd+\\', id: 'toggle-sidebar', label: 'Toggle sidebar' },
  { keys: 'Cmd+F', id: 'focus-filter', label: 'Focus Library filter' },
  { keys: 'Cmd+[', id: 'prev-doc', label: 'Previous document' },
  { keys: 'Cmd+]', id: 'next-doc', label: 'Next document' },
  { keys: 'Cmd+1…9', id: 'nth-doc', label: 'Open the nth document' },
  { keys: 'F6', id: 'next-region', label: 'Next focus region' },
  { keys: 'Shift+F6', id: 'prev-region', label: 'Previous focus region' },
];

export function matchShortcut(e: KeyLike): ShortcutMatch | null {
  if (e.key === 'F6' && !e.metaKey && !e.ctrlKey && !e.altKey) {
    return { id: e.shiftKey ? 'prev-region' : 'next-region' };
  }
  if (!e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return null;
  const k = e.key.toLowerCase();
  switch (k) {
    case 'l':
      return { id: 'focus-url' };
    case 'n':
      return { id: 'new-draft' };
    case ',':
      return { id: 'settings' };
    case '\\':
      return { id: 'toggle-sidebar' };
    case 'f':
      return { id: 'focus-filter' };
    case '[':
      return { id: 'prev-doc' };
    case ']':
      return { id: 'next-doc' };
  }
  if (/^[1-9]$/.test(k)) return { id: 'nth-doc', index: Number(k) - 1 };
  return null;
}
