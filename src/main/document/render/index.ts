// renderDocument (07 §8): pure function of the model, asset bytes, runtime and theme (07 §5.5).
import { bundledDocRuntime } from '../runtime-assets';
import { defaultDocTheme } from '../theme';
import type { DocumentModel, RenderOptions } from '../types';
import { renderWithRuntime } from './page';

export function renderDocument(
  model: DocumentModel,
  assets: ReadonlyMap<string, Uint8Array>,
  opts: RenderOptions = {},
): string {
  return renderWithRuntime(model, assets, opts.runtime ?? bundledDocRuntime(), opts.theme ?? defaultDocTheme);
}

export { renderSectionHtml, modelJson, formatDate, displayLabel, footerText, TAB_LABEL_MAX } from './page';
export { documentCsp, scriptHash } from './csp';
