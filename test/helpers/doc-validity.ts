/**
 * validateDocument (13 §7): static validity checks for a generated index.html. The rules live in
 * src/main/document/validity.ts so writers run the same checks before every save (13 §7).
 */
// validity.ts directly, not the module index: the index pulls in Electron, and Playwright e2e
// specs run this helper in plain Node.
import { checkDocumentHtml } from '../../src/main/document/validity';
import type { DocumentMeta } from '../../src/main/library';
import type { ValidityError, ValidityMeta, ValidityReport, ValidityRule } from '../../src/main/document/validity';

export type { ValidityError, ValidityReport, ValidityRule };

export function validateDocument(html: string, meta?: DocumentMeta | ValidityMeta): ValidityReport {
  return checkDocumentHtml(html, meta);
}

/** Throws with every error listed; convenient in tests. */
export function assertValidDocument(html: string, meta?: DocumentMeta | ValidityMeta): ValidityReport {
  const r = validateDocument(html, meta);
  if (!r.ok) throw new Error(`Invalid document:\n${r.errors.map((e) => `  ${e.rule}: ${e.detail}`).join('\n')}`);
  return r;
}
