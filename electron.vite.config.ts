import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import type { Plugin } from 'vite';
import { APP_CSP_DEV, APP_CSP_PROD } from './src/main/security/csp';

const root = import.meta.dirname;

// electron-vite 5's isolated-entries reporter calls TTY-only cursor methods unconditionally, which
// throws in CI and other piped output. No-ops keep the preload build working there.
if (!process.stdout.isTTY) {
  Object.assign(process.stdout, { clearLine: () => true, cursorTo: () => true, moveCursor: () => true });
}

/** Edition and overlay resolution (01 §6.5, HOOK-CFG-02). */
function resolveEdition(): { edition: 'public' | 'enterprise'; overlay: string } {
  const edition = process.env.ELI5_EDITION ?? 'public';
  if (edition !== 'public' && edition !== 'enterprise') {
    throw new Error(`Unknown ELI5_EDITION "${edition}" (expected public or enterprise)`);
  }
  if (edition === 'public') return { edition, overlay: resolve(root, 'src/main/editions/overlay.none.ts') };
  const dir = resolve(root, process.env.ELI5_OVERLAY_DIR ?? './enterprise/');
  const entry = resolve(dir, 'index.ts');
  if (!existsSync(entry)) {
    throw new Error(`Enterprise build requires an overlay at ${dir}/index.ts (set ELI5_OVERLAY_DIR)`);
  }
  return { edition, overlay: entry };
}

const { edition, overlay } = resolveEdition();
const testBuild = process.env.ELI5_TEST_BUILD === '1';
const define = {
  __ELI5_EDITION__: JSON.stringify(edition),
  __ELI5_TEST__: JSON.stringify(testBuild),
};

/** Injects the app renderer CSP meta tag (12 §7.4). */
function cspMeta(): Plugin {
  return {
    name: 'eli5-csp-meta',
    transformIndexHtml: {
      order: 'pre',
      handler: (html, ctx) => html.replace('%CSP%', ctx.server ? APP_CSP_DEV : APP_CSP_PROD),
    },
  };
}

export default defineConfig({
  main: {
    define,
    resolve: {
      alias: {
        '@eli5/overlay': overlay,
        '@eli5/public': resolve(root, 'src/main'),
      },
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve(root, 'src/main/index.ts'),
          // utilityProcess entry for extraction (04 §6), bundled to out/main/extract-worker.js.
          'extract-worker': resolve(root, 'src/main/extract/worker.ts'),
        },
        // Readability and its DOM are loaded only inside the Readability worker (01 §7, 05 §5.2).
        external: ['jsdom', '@mozilla/readability', '@napi-rs/keyring'],
      },
    },
  },
  preload: {
    define,
    build: {
      // Each sandboxed preload must be a single standalone file (no shared chunks, no externals).
      isolatedEntries: true,
      externalizeDeps: false,
      rollupOptions: {
        input: {
          app: resolve(root, 'src/preload/app.ts'),
          doc: resolve(root, 'src/preload/doc.ts'),
        },
        // Sandboxed preloads must be CommonJS (01 §8.1).
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    define,
    root: resolve(root, 'src/renderer'),
    plugins: [react(), cspMeta()],
    build: {
      minify: true,
      rollupOptions: { input: { index: resolve(root, 'src/renderer/index.html') } },
    },
  },
});
