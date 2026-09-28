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
    action: 'expand' | 'reexplain' | 'analogy' | 'deeper';
    selectionText: string;
    note?: string;
  }): Promise<BridgeResult>;
  createSectionEli5(r: {
    tabKey: string;
    sectionId: string;
    selectionText: string;
    note?: string;
  }): Promise<BridgeResult>;
  closeTab(tabKey: string): Promise<BridgeResult>;
  openExternal(url: string): Promise<BridgeResult>;
  onScrollTo(cb: (e: { sectionId?: string; tabKey?: string; flash: boolean; loadSeq: number }) => void): () => void;
  onSectionBusy(cb: (e: { busy: { sectionId: string; action: string }[] }) => void): () => void;
}

/** 07 §6.3: the app is detected with `typeof window.eli5Doc === 'object'`. */
export function getBridge(win: Window): DocBridge | undefined {
  const b = (win as unknown as { eli5Doc?: unknown }).eli5Doc;
  return typeof b === 'object' && b !== null ? (b as DocBridge) : undefined;
}
