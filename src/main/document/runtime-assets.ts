// The bundled doc-runtime (01 §8.1): build/doc-runtime/runtime.iife.js and runtime.css, produced by
// `npm run build:runtime` and inlined as ?raw strings. An eager glob is used instead of a plain
// `?raw` import so unit tests and typechecks work before the pre-step has run; the build pre-step
// always runs before electron-vite (package.json "build"/"dev"), so production bundles contain it.
import { DocRuntimeMissingError } from './errors';
import type { DocRuntime } from './types';

/** Recorded in DocumentModel.generator.runtimeVersion; bump when the runtime contract changes. */
export const DOC_RUNTIME_VERSION = '1.3.4';

/**
 * The first runtime with the current chart slot order (07 §11.1). Diagram SVG stored by an
 * older runtime carries theme classes numbered for the old palette; parse remaps them (07 §7.3).
 */
export const PALETTE_RUNTIME_VERSION = '1.1.1';

/** -1, 0 or 1 for dotted numeric versions ('1.0.0' < '1.2'); a non-number part counts as 0. */
export function compareRuntimeVersions(a: string, b: string): number {
  const pa = a.split('.').map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split('.').map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

const files = import.meta.glob<string>(
  ['../../../build/doc-runtime/runtime.iife.js', '../../../build/doc-runtime/runtime.css'],
  {
    query: '?raw',
    import: 'default',
    eager: true,
  },
);

export const DOC_RUNTIME_JS: string = files['../../../build/doc-runtime/runtime.iife.js'] ?? '';
export const DOC_RUNTIME_CSS: string = files['../../../build/doc-runtime/runtime.css'] ?? '';

/** The bundled runtime; throws DocRuntimeMissingError when the pre-step did not run. */
export function bundledDocRuntime(): DocRuntime {
  if (DOC_RUNTIME_JS === '' || DOC_RUNTIME_CSS === '') throw new DocRuntimeMissingError();
  return { js: DOC_RUNTIME_JS, css: DOC_RUNTIME_CSS };
}
