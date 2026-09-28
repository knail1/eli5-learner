import { resolve } from 'node:path';
import { defineConfig } from 'vite';

/** doc-runtime pre-step (01 §8.1): one IIFE + CSS, no imports, inlined into every document. */
export default defineConfig({
  build: {
    outDir: resolve(import.meta.dirname, 'build/doc-runtime'),
    emptyOutDir: true,
    target: 'es2020',
    minify: true,
    cssCodeSplit: false,
    lib: {
      entry: resolve(import.meta.dirname, 'src/doc-runtime/index.ts'),
      name: 'Eli5DocRuntime',
      formats: ['iife'],
      fileName: () => 'runtime.iife.js',
      cssFileName: 'runtime',
    },
  },
});
