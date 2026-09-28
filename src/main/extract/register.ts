import type { CapabilityRegistry } from '../editions';

/**
 * Public extractor registrations (04 §3). The static order is fixed:
 * pptx, docx, pdf, xlsx, csv, image, markdown, text, html. Extractors land in M1.
 */
export function registerPublic(_reg: CapabilityRegistry): void {
  // M0: nothing registered yet.
}
