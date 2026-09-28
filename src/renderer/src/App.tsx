import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { CatalogEntry, Settings, SettingsSection, UiRoute } from '../../preload/contract';
import { AnnouncerProvider } from './a11y/Announcer';
import { matchShortcut } from './a11y/shortcuts';
import { EditionProvider, FeatureGate } from './edition/FeatureGate';
import { InputZone, type InputZoneHandle } from './input/InputZone';
import { LibrarySidebar } from './library/LibrarySidebar';
import { sortCatalog } from './library/order';
import { readLastDoc, rememberDoc, resolveRoute, sameRoute, startupRoute } from './routes';
import { SettingsScreen, SignInIndicator } from './settings/SettingsScreen';
import { StatusArea } from './status/StatusArea';
import { SuggestionsPanel } from './suggestions/SuggestionsPanel';
import { DocHeader } from './viewer/DocHeader';
import { NotFound, Welcome } from './viewer/ViewerEmpty';
import { ViewerSlot } from './viewer/ViewerSlot';

export type { UiRoute, SettingsSection };
export type { AppNavigateEvent } from '../../preload/contract';

/**
 * Top-level layout and route switch (11 §5, §6). The renderer is a view: documents, jobs,
 * suggestions and settings come from main and re-render on the matching change events.
 */
export function App() {
  return (
    <EditionProvider>
      <AnnouncerProvider>
        <Shell />
      </AnnouncerProvider>
    </EditionProvider>
  );
}

const SIDEBAR = { def: 272, min: 200, max: 420, step: 16, narrow: 1000 };
const SIDEBAR_KEY = 'eli5.sidebar';

function readSidebar(): { width: number; collapsed: boolean } {
  try {
    const v = JSON.parse(window.localStorage.getItem(SIDEBAR_KEY) ?? 'null') as unknown;
    if (v && typeof v === 'object') {
      const o = v as { width?: unknown; collapsed?: unknown };
      return {
        width: typeof o.width === 'number' ? clampSidebar(o.width) : SIDEBAR.def,
        collapsed: o.collapsed === true,
      };
    }
  } catch {
    // per-viewer convenience only
  }
  return { width: SIDEBAR.def, collapsed: false };
}

const clampSidebar = (w: number) => Math.round(Math.min(SIDEBAR.max, Math.max(SIDEBAR.min, w)));

function Shell() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [keyEpoch, setKeyEpoch] = useState(0);
  const [catalog, setCatalog] = useState<CatalogEntry[] | null>(null);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [route, setRouteState] = useState<UiRoute>({ view: 'welcome' });
  const previous = useRef<UiRoute>({ view: 'welcome' });
  const startupDone = useRef(false);
  const [sidebar, setSidebar] = useState(readSidebar);
  const [narrow, setNarrow] = useState(() => window.innerWidth < SIDEBAR.narrow);
  // Below 1000 px the sidebar starts collapsed, but Cmd+\ and Cmd+F can still open it; this
  // override is per narrow spell and never touches the persisted collapsed flag (11 §5.2, §12).
  const [narrowOpen, setNarrowOpen] = useState(false);
  const inputZone = useRef<InputZoneHandle>(null);
  const filterRef = useRef<HTMLInputElement>(null);

  const provider = settings?.llm.provider ?? 'claude';

  // ---- data from main ----
  useEffect(() => {
    void window.eli5.settings.get().then((r) => r.ok && setSettings(r.value));
    return window.eli5.settings.onChanged((e) => setSettings(e.settings));
  }, []);

  useEffect(() => {
    if (provider !== 'claude' && provider !== 'openai') {
      setHasKey(true); // key-less providers come from the overlay (HOOK-LLM-01)
      return;
    }
    let live = true;
    void window.eli5.settings.hasApiKey(provider).then((r) => live && setHasKey(r.ok ? r.value : null));
    return () => {
      live = false;
    };
  }, [provider, keyEpoch]);

  const loadLibrary = useCallback(async () => {
    const r = await window.eli5.library.list();
    if (r.ok) {
      setCatalog(sortCatalog(r.value));
      setLibraryError(null);
    } else {
      setLibraryError(r.error.message);
    }
  }, []);

  useEffect(() => {
    void loadLibrary();
    return window.eli5.library.onChanged((e) => {
      setCatalog(sortCatalog(e.entries));
      setLibraryError(null);
    });
  }, [loadLibrary]);

  // ---- opening a document in the viewer (11 §5.2, §8, §13) ----
  // An ok:false answer is an IPC failure, reported inline with Retry while the viewer stays
  // attached (11 §13). The "Could not display" state belongs to the viewer's did-fail-load.
  const [openError, setOpenError] = useState<{ slug: string; message: string } | null>(null);
  // Slugs main answered E_NOT_FOUND for: shown as missing whatever the catalog still lists (11 §8).
  const [missing, setMissing] = useState<ReadonlySet<string>>(new Set());
  const openSeq = useRef(0);
  const openInViewer = useCallback(
    (slug: string) => {
      const seq = ++openSeq.current;
      setOpenError(null);
      void window.eli5.library.open(slug).then((r) => {
        // Only the latest open decides what the viewer area shows.
        if (seq !== openSeq.current) return;
        setMissing((m) => {
          if (r.ok ? !m.has(slug) : r.error.code !== 'E_NOT_FOUND' || m.has(slug)) return m;
          const next = new Set(m);
          if (r.ok) next.delete(slug);
          else next.add(slug);
          return next;
        });
        if (r.ok) return;
        // Gone from main: also reload the Library so the sidebar drops it.
        if (r.error.code === 'E_NOT_FOUND') void loadLibrary();
        else setOpenError({ slug, message: r.error.message });
      });
    },
    [loadLibrary],
  );

  // ---- routes (11 §6) ----
  const go = useCallback(
    (next: UiRoute) => {
      startupDone.current = true;
      setRouteState((cur) => {
        if (sameRoute(cur, next)) return cur;
        if (next.view === 'settings' && cur.view !== 'settings') previous.current = cur;
        return next;
      });
      if (next.view === 'doc') {
        rememberDoc(next.slug);
        openInViewer(next.slug);
      }
    },
    [openInViewer],
  );

  // Startup: the last opened document if it still exists, else welcome.
  useEffect(() => {
    if (startupDone.current || catalog === null) return;
    startupDone.current = true;
    const r = startupRoute(catalog, readLastDoc());
    if (r.view === 'doc') go(r);
  }, [catalog, go]);

  useEffect(() => window.eli5.app.onNavigate((e) => go(e.route)), [go]);

  const openSettings = useCallback((section?: SettingsSection) => go({ view: 'settings', section }), [go]);
  const leaveSettings = useCallback(() => go(previous.current), [go]);
  const openDoc = useCallback((slug: string) => go({ view: 'doc', slug }), [go]);

  const resolved = resolveRoute(route, catalog);
  const shown: UiRoute =
    resolved.view === 'doc' && missing.has(resolved.slug) ? { view: 'not-found', slug: resolved.slug } : resolved;
  const selectedSlug = shown.view === 'doc' ? shown.slug : null;

  // ---- sidebar: collapse (Cmd+\), resize, auto-collapse below 1000 px (11 §5.2, §12) ----
  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_KEY, JSON.stringify(sidebar));
    } catch {
      // per-viewer convenience only
    }
  }, [sidebar]);
  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < SIDEBAR.narrow);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  useEffect(() => {
    if (!narrow) setNarrowOpen(false);
  }, [narrow]);
  const collapsed = narrow ? !narrowOpen : sidebar.collapsed;
  const narrowRef = useRef(narrow);
  narrowRef.current = narrow;

  // ---- shortcuts (11 §9) ----
  const catalogRef = useRef(catalog);
  catalogRef.current = catalog;
  const selectedRef = useRef(selectedSlug);
  selectedRef.current = selectedSlug;
  const routeRef = useRef(route);
  routeRef.current = route;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (e.key === 'Escape') {
        if (routeRef.current.view === 'settings') leaveSettings();
        return;
      }
      const m = matchShortcut(e);
      if (!m) return;
      const docs = catalogRef.current ?? [];
      const at = docs.findIndex((d) => d.topicSlug === selectedRef.current);
      e.preventDefault();
      switch (m.id) {
        case 'focus-url':
          inputZone.current?.focusUrl();
          break;
        case 'new-draft':
          inputZone.current?.clearDraft();
          inputZone.current?.focusDropBox();
          break;
        case 'settings':
          openSettings();
          break;
        case 'toggle-sidebar':
          if (narrowRef.current) setNarrowOpen((o) => !o);
          else setSidebar((s) => ({ ...s, collapsed: !s.collapsed }));
          break;
        case 'focus-filter':
          if (narrowRef.current) setNarrowOpen(true);
          else setSidebar((s) => ({ ...s, collapsed: false }));
          requestAnimationFrame(() => filterRef.current?.focus());
          break;
        case 'prev-doc': {
          const d = docs[at <= 0 ? 0 : at - 1];
          if (d) openDoc(d.topicSlug);
          break;
        }
        case 'next-doc': {
          const d = docs[Math.min(docs.length - 1, at + 1)];
          if (d) openDoc(d.topicSlug);
          break;
        }
        case 'nth-doc': {
          const d = docs[m.index ?? 0];
          if (d) openDoc(d.topicSlug);
          break;
        }
        case 'next-region':
        case 'prev-region':
          cycleRegion(m.id === 'next-region' ? 1 : -1);
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [leaveSettings, openDoc, openSettings]);

  const layoutKey = `${collapsed ? 0 : sidebar.width}`;
  const style = useMemo(
    () => ({ '--sidebar-w': collapsed ? '0px' : `${sidebar.width}px` }) as CSSProperties,
    [collapsed, sidebar.width],
  );
  const entry = selectedSlug ? catalog?.find((e) => e.topicSlug === selectedSlug) : undefined;

  return (
    <div className={`shell${collapsed ? ' sidebar-collapsed' : ''}`} style={style}>
      <div className="titlebar-drag" aria-hidden="true" />
      <aside className="sidebar" data-region="sidebar" hidden={collapsed}>
        <LibrarySidebar
          entries={catalog}
          error={libraryError}
          selectedSlug={selectedSlug}
          onOpen={openDoc}
          onRetry={() => void loadLibrary()}
          filterRef={filterRef}
        />
        <div data-region="suggestions">
          <SuggestionsPanel onOpenDoc={openDoc} currentSlug={selectedSlug} />
        </div>
        <footer className="sidebar-footer">
          <button
            type="button"
            className="settings-button"
            aria-current={shown.view === 'settings' ? 'page' : undefined}
            onClick={() => (shown.view === 'settings' ? leaveSettings() : openSettings())}
          >
            <span aria-hidden="true">⚙</span> Settings
          </button>
          <FeatureGate feature="auth.signIn">
            <SignInIndicator />
          </FeatureGate>
        </footer>
      </aside>
      {!collapsed && (
        <SidebarHandle width={sidebar.width} onChange={(w) => setSidebar((s) => ({ ...s, width: clampSidebar(w) }))} />
      )}
      <div className="main-col">
        <main className="viewer-area" data-region="viewer" tabIndex={-1} aria-label="Viewer">
          {shown.view === 'doc' && (
            <>
              <DocHeader slug={shown.slug} entry={entry} />
              {openError?.slug === shown.slug && (
                <p className="inline-error open-error" role="alert">
                  {openError.message}{' '}
                  <button type="button" onClick={() => openInViewer(shown.slug)}>
                    Retry
                  </button>
                </p>
              )}
              <ViewerSlot slug={shown.slug} layoutKey={layoutKey} />
            </>
          )}
          {shown.view === 'welcome' && (
            <Welcome hasKey={hasKey} libraryEmpty={!catalog?.length} onAddKey={() => openSettings('ai')} />
          )}
          {shown.view === 'not-found' && <NotFound />}
          {shown.view === 'settings' && (
            <SettingsScreen
              settings={settings}
              section={shown.section}
              onKeyChanged={() => setKeyEpoch((n) => n + 1)}
            />
          )}
        </main>
        <div className="bottom-row">
          <div data-region="input">
            <InputZone
              ref={inputZone}
              glossaryDefault={settings?.glossary.defaultOn ?? true}
              provider={provider}
              onOpenSettings={() => openSettings('ai')}
            />
          </div>
          <div data-region="status">
            <StatusArea onOpenDoc={openDoc} onOpenSettings={() => openSettings('ai')} />
          </div>
        </div>
      </div>
    </div>
  );
}

/** Keyboard `separator`; arrow keys move 16 px (11 §5.2). */
function SidebarHandle(p: { width: number; onChange(w: number): void }) {
  return (
    <div
      className="sidebar-handle"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuenow={p.width}
      aria-valuemin={SIDEBAR.min}
      aria-valuemax={SIDEBAR.max}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault();
          p.onChange(p.width + (e.key === 'ArrowRight' ? SIDEBAR.step : -SIDEBAR.step));
        }
      }}
      onPointerDown={(e) => {
        const startX = e.clientX;
        const startW = p.width;
        const el = e.currentTarget;
        el.setPointerCapture?.(e.pointerId);
        const move = (ev: PointerEvent) => p.onChange(startW + ev.clientX - startX);
        const up = () => {
          el.removeEventListener('pointermove', move);
          el.removeEventListener('pointerup', up);
        };
        el.addEventListener('pointermove', move);
        el.addEventListener('pointerup', up);
      }}
    />
  );
}

/** F6 / Shift+F6: sidebar → viewer → input zone → status → suggestions (11 §9, §12). */
function cycleRegion(dir: 1 | -1): void {
  const order = ['sidebar', 'viewer', 'input', 'status', 'suggestions'];
  const regions = order
    .map((r) => document.querySelector<HTMLElement>(`[data-region="${r}"]`))
    .filter((el): el is HTMLElement => !!el && !el.closest('[hidden]') && el.childElementCount > 0);
  if (regions.length === 0) return;
  const current = regions.findIndex((r) => r.contains(document.activeElement));
  const next = regions[(current + dir + regions.length) % regions.length];
  const target =
    next?.querySelector<HTMLElement>('button, input, textarea, [tabindex="0"], [tabindex="-1"]') ?? next ?? null;
  target?.focus();
}
