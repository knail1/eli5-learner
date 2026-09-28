// The bundled doc-runtime (01 §8.1): build/doc-runtime/runtime.iife.js and runtime.css, produced by
// `npm run build:runtime` and inlined as ?raw strings. An eager glob is used instead of a plain
// `?raw` import so unit tests and typechecks work before the pre-step has run; the build pre-step
// always runs before electron-vite (package.json "build"/"dev"), so production bundles contain it.
import { DocRuntimeMissingError } from './errors';
import type { DocRuntime } from './types';

/** Recorded in DocumentModel.generator.runtimeVersion; bump when the runtime contract changes. */
export const DOC_RUNTIME_VERSION = '1.0.0';

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
