import { pathToFileURL } from 'node:url';
import type { ElectronApplication } from '@playwright/test';

/**
 * probeDocument (13 §7.2): opens a document file in a hidden BrowserWindow on a dedicated,
 * in-memory partition whose onBeforeRequest records and cancels every request other than the
 * document itself and data: URIs. After load it switches through every tab, toggles every glossary
 * note, and resizes below the glossary breakpoint (07 §9.2: 1100 px) and back. Pass: `requests` and
 * `consoleErrors` empty. Not a spec file itself (no `.e2e.ts` suffix).
 */
export interface ProbeResult {
  /** The doc-runtime booted (html.js). */
  booted: boolean;
  /** Tab buttons walked. */
  tabs: number;
  requests: string[];
  consoleErrors: string[];
}

export async function probeDocument(app: ElectronApplication, file: string): Promise<ProbeResult> {
  const docUrl = pathToFileURL(file).href;
  return app.evaluate(
    async ({ BrowserWindow, session }, { docUrl, partition }) => {
      const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
      const ses = session.fromPartition(partition);
      const requests: string[] = [];
      const consoleErrors: string[] = [];
      ses.webRequest.onBeforeRequest((d, cb) => {
        const ok = d.url === docUrl || d.url.startsWith('data:');
        if (!ok) requests.push(d.url);
        cb({ cancel: !ok });
      });
      const win = new BrowserWindow({
        show: false,
        width: 1280,
        height: 900,
        webPreferences: { partition, sandbox: true, contextIsolation: true, nodeIntegration: false },
      });
      win.webContents.on('console-message', (e) => {
        if (e.level === 'error') consoleErrors.push(e.message);
      });
      try {
        await win.loadURL(docUrl);
        const run = <T>(js: string): Promise<T> => win.webContents.executeJavaScript(js) as Promise<T>;
        const booted = await run<boolean>("document.documentElement.classList.contains('js')");
        const tabs = await run<number>(`(() => {
          const tabs = Array.from(document.querySelectorAll('nav.tabbar [role="tab"]'));
          for (const t of tabs) t.click();
          if (tabs[0]) tabs[0].click();
          return tabs.length;
        })()`);
        const toggleNotes = `(() => {
          for (const s of document.querySelectorAll('details.gl-note > summary')) { s.click(); s.click(); }
        })()`;
        await run(toggleNotes);
        win.setSize(800, 900);
        await sleep(100);
        await run(toggleNotes);
        win.setSize(1280, 900);
        await sleep(100);
        win.setSize(800, 900);
        // Let late timers or lazy work run.
        await sleep(250);
        return { booted, tabs, requests, consoleErrors };
      } finally {
        win.destroy();
        ses.webRequest.onBeforeRequest(null);
      }
    },
    { docUrl, partition: `probe-${String(Date.now())}-${String(Math.random()).slice(2)}` },
  );
}
