import { FILE_URL_TYPE, FILENAMES_PBOARD_TYPE, type ClipboardPort } from '../sources';

/** The subset of Electron 44's async `clipboard` (W3C shape) read at paste time. */
export interface AsyncClipboard {
  read(): Promise<{ types: readonly string[]; getType(type: string): Promise<unknown> }[]>;
  readText(): Promise<string>;
  has(mimetype: string): Promise<boolean>;
}

/** Raw pasteboard types are reached through Electron's custom `osclipboard` MIME type. */
const osFormat = (f: string): string => `electron application/osclipboard;format="${f}"`;

/**
 * Snapshots the clipboard once (03 §6.1: at paste time) into 03's synchronous ClipboardPort, so
 * the routing algorithm (03 §6.2) runs unchanged. Every read failure counts as "absent".
 */
export async function snapshotClipboard(cb: AsyncClipboard): Promise<ClipboardPort> {
  const items = await cb.read().catch(() => []);
  const types = [...new Set(items.flatMap((i) => i.types))];
  const blob = async (type: string, listed: boolean): Promise<Blob | undefined> => {
    for (const item of items) {
      if (listed && !item.types.includes(type)) continue;
      const v = await item.getType(type).catch(() => undefined);
      if (v instanceof Blob) return v;
    }
    return undefined;
  };
  const text = async (type: string): Promise<string> => (await (await blob(type, true))?.text()) ?? '';
  const raw = async (f: string): Promise<string> => {
    if (!(await cb.has(osFormat(f)).catch(() => false))) return '';
    return (await (await blob(osFormat(f), false))?.text()) ?? '';
  };

  const plain = types.includes('text/plain') ? await text('text/plain') : await cb.readText().catch(() => '');
  const html = await text('text/html');
  const pngBlob = await blob('image/png', true);
  const png = pngBlob ? Buffer.from(await pngBlob.arrayBuffer()) : Buffer.alloc(0);
  const rawFormats: Record<string, string> = {
    [FILENAMES_PBOARD_TYPE]: await raw(FILENAMES_PBOARD_TYPE),
    [FILE_URL_TYPE]: await raw(FILE_URL_TYPE),
  };

  return {
    availableFormats: () => types,
    read: (format) => rawFormats[format] ?? '',
    readText: () => plain,
    readHTML: () => html,
    readImage: () => ({ isEmpty: () => png.length === 0, toPNG: () => png }),
    readBuffer: () => Buffer.alloc(0),
  };
}
