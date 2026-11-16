// Typed access to window.eli5Doc (01 §5.3). The runtime imports nothing outside this folder, so
// the surface is restated structurally; absent in a plain browser (07 §6.3).

export interface BridgeResult {
  ok: boolean;
  error?: { message?: string };
}

export interface DocBridge {
  regenerateSection(r: {
    tabKey: string;
    sectionId: string;
    action: 'expand' | 'reexplain' | 'analogy' | 'deeper' | 'revise';
    selectionText: string;
    note?: string;
  }): Promise<BridgeResult>;
  /** `scope: 'selection'` is "ELI5 this selection" (08 §7.5): `sectionIds` = covered sections, first = sectionId. */
  createSectionEli5(r: {
    tabKey: string;
    sectionId: string;
    selectionText: string;
    note?: string;
    scope?: 'selection';
    sectionIds?: string[];
  }): Promise<BridgeResult>;
  /** Ask (08 §6.8): the answer box goes after the selection. Absent in an older app's bridge. */
  askQuestion?(r: {
    tabKey: string;
    sectionId: string;
    selectionText: string;
    question: string;
  }): Promise<BridgeResult>;
  /**
   * Deep Ask (08 §6.9): also reads every tab and the document's kept source text. Absent in an
   * older app's bridge, so the runtime feature-detects it and hides the button.
   */
  askDeep?(r: { tabKey: string; sectionId: string; selectionText: string; question: string }): Promise<BridgeResult>;
  /**
   * Ask deeper (08 §6.10): the same material, then the web, then general knowledge. Absent in an
   * older app's bridge, so the runtime feature-detects it and hides the button.
   */
  askDeeper?(r: { tabKey: string; sectionId: string; selectionText: string; question: string }): Promise<BridgeResult>;
  closeTab(tabKey: string): Promise<BridgeResult>;
  openExternal(url: string): Promise<BridgeResult>;
  /** `anchorId`: an element inside the section to land on instead (an answer box, 08 Ask). */
  onScrollTo(
    cb: (e: { sectionId?: string; tabKey?: string; anchorId?: string; flash: boolean; loadSeq: number }) => void,
  ): () => void;
  onSectionBusy(
    cb: (e: {
      /** `depth` only on Ask deep ('deep') or Ask deeper ('deeper'), action 'ask'. */
      busy: { sectionId: string; action: string; depth?: string }[];
      notices?: { sectionId: string; message: string }[];
    }) => void,
  ): () => void;
}

/** 07 §6.3: the app is detected with `typeof window.eli5Doc === 'object'`. */
export function getBridge(win: Window): DocBridge | undefined {
  const b = (win as unknown as { eli5Doc?: unknown }).eli5Doc;
  return typeof b === 'object' && b !== null ? (b as DocBridge) : undefined;
}
