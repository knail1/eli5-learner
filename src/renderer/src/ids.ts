/** Renderer-minted ids (03 §2, 11 §5.4). */

export function randomHex(chars: number): string {
  const bytes = new Uint8Array(Math.ceil(chars / 2));
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, chars);
}

/** "draft-" + 8 hex; a new one after every start or clear. */
export const newDraftId = (): string => `draft-${randomHex(8)}`;

/** "in-" + 8 hex, assigned when the chip is created. */
export const newInputId = (): string => `in-${randomHex(8)}`;
