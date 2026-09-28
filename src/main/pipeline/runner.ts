// In-process extraction (tests and Node harnesses); production runs ExtractWorkerHost (04 §10.4).
import { extractSource, type Extractor, type ImageNormalizer, type PdfPageRenderer } from '../extract';
import type { ExtractRunner, JobId } from './types';

export interface InProcessExtractOptions {
  renderPdfPages: PdfPageRenderer;
  normalizeImage: ImageNormalizer;
  extractors?: readonly Extractor[];
  log?: (msg: string) => void;
}

/** An ExtractRunner factory that calls extractSource directly in this process. */
export function inProcessExtractRunner(o: InProcessExtractOptions): (jobId: JobId) => ExtractRunner {
  return () => ({
    extract: (source, x) =>
      extractSource(
        source,
        {
          signal: x.signal,
          limits: x.limits,
          imageBudget: x.budget,
          renderPdfPages: o.renderPdfPages,
          normalizeImage: o.normalizeImage,
          log: o.log ?? (() => {}),
        },
        o.extractors,
      ),
    dispose: () => {},
  });
}
