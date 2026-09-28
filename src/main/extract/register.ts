import type { CapabilityRegistry } from '../editions';
import { createPublicExtractors } from './extract-source';

/**
 * Public extractor registrations (04 §3). The static order is fixed:
 * pptx, docx, pdf, xlsx, csv, image, markdown, text, html. Extraction is identical in both
 * editions; enterprise resolvers reuse these extractors unchanged.
 */
export function registerPublic(reg: CapabilityRegistry): void {
  for (const e of createPublicExtractors()) reg.registerExtractor(e);
}
