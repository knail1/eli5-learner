import { existsSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import type { Plugin } from 'vite';
import { APP_CSP_DEV, APP_CSP_PROD } from '../src/main/security/csp';

// Every path below is relative to the repository root. electron-vite bundles this file to a temp
// module before running it, so import.meta.dirname is not reliably config/: walk up to package.json.
const root = (() => {
  let dir = import.meta.dirname;
  while (!existsSync(resolve(dir, 'package.json')) && dirname(dir) !== dir) dir = dirname(dir);
  return dir;
})();

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

/**
 * Records the resolved `@eli5/overlay` id and any bundled module from outside the public sources to
 * out/main/build-info.json, read by scripts/check-hygiene.ts (13 §11 rule 4): the inlined overlay
 * leaves no path in the bundle text.
 */
function buildInfo(): Plugin {
  const rel = (id: string): string => relative(root, id).split(sep).join('/');
  return {
    name: 'eli5-build-info',
    async generateBundle() {
      const resolved = await this.resolve('@eli5/overlay', resolve(root, 'src/main/index.ts'));
      const foreign = [...this.getModuleIds()]
        .filter((id) => !id.startsWith('\0') && !id.includes('/node_modules/') && resolve(id) === id)
        .map(rel)
        .map((id) => id.replace(/\?.*$/, ''))
        // src/ and the generated doc runtime (build/doc-runtime, from build:runtime) are public.
        .filter((id) => !id.startsWith('src/') && !id.startsWith('build/doc-runtime/'))
        .sort();
      const info = { edition, overlay: resolved ? rel(resolved.id) : null, foreign };
      this.emitFile({ type: 'asset', fileName: 'build-info.json', source: `${JSON.stringify(info, null, 2)}\n` });
    },
  };
}

export default defineConfig({
  main: {
    define,
    plugins: [buildInfo()],
    resolve: {
      // Overlays reach public code only as `@eli5/public/<module>` → its index.ts, plus the test
      // entry `llm/testing`; a deep import matches nothing and fails the build (01 §6.5 step 4.3).
      alias: [
        { find: '@eli5/overlay', replacement: overlay },
        {
          find: /^@eli5\/public\/([a-z-]+(?:\/testing)?)$/,
          replacement: `${resolve(root, 'src/main')}/$1/index.ts`,
        },
      ],
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
