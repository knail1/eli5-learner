/**
 * Builds the doc-runtime in memory with the real Vite config (01 §8.1) so golden documents embed
 * the exact DOC_RUNTIME_JS / DOC_RUNTIME_CSS, without writing build/. Node environment only.
 */
import { resolve } from 'node:path';
import { build, type Rollup } from 'vite';
import type { DocRuntime } from '../../../src/main/document';

const ROOT = resolve(import.meta.dirname, '../../..');

let cached: Promise<DocRuntime> | undefined;

export function buildRuntime(): Promise<DocRuntime> {
  cached ??= (async () => {
    const out = (await build({
      configFile: resolve(ROOT, 'config/vite.doc-runtime.config.ts'),
      logLevel: 'silent',
      build: { write: false },
    })) as Rollup.RollupOutput | Rollup.RollupOutput[];
    const outputs = (Array.isArray(out) ? out : [out]).flatMap((o) => o.output);
    let js = '';
    let css = '';
    for (const o of outputs) {
      if (o.type === 'chunk' && o.fileName === 'runtime.iife.js') js = o.code;
      if (o.type === 'asset' && o.fileName === 'runtime.css')
        css = typeof o.source === 'string' ? o.source : new TextDecoder().decode(o.source);
    }
    if (!js || !css) throw new Error('doc-runtime build produced no runtime.iife.js / runtime.css');
    return { js, css };
  })();
  return cached;
}
