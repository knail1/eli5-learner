import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type {
  CatalogEntry,
  FindCommand,
  LibraryOrganization,
  Settings,
  SettingsSection,
  UiRoute,
} from '../../preload/contract';
import { AnnouncerProvider } from './a11y/Announcer';
import { matchShortcut } from './a11y/shortcuts';
import { EditionProvider, FeatureGate } from './edition/FeatureGate';
import { InputZone, type InputZoneHandle } from './input/InputZone';
import { LibrarySidebar } from './library/LibrarySidebar';
import { sortCatalog } from './library/order';
import { EMPTY_ORGANIZATION } from './library/organize';
import { InTrash, TrashView } from './library/TrashView';
import { readLastDoc, rememberDoc, resolveRoute, sameRoute, startupRoute } from './routes';
import { SettingsScreen, SignInIndicator } from './settings/SettingsScreen';
import { StatusArea } from './status/StatusArea';
import { SuggestionsPanel } from './suggestions/SuggestionsPanel';
import { TopStatus } from './top-status/TopStatus';
import { BottomHandle, useBottomPanel } from './layout/BottomPanel';
import { DocHeader } from './viewer/DocHeader';
import { PanelHandle } from './viewer/PanelHandle';
import { useVersionTree, VersionTreePanel } from './viewer/VersionTreePanel';
import { FindBar, type FindBarHandle } from './viewer/FindBar';
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

/** Versions panel (11 §5.7): closed by default; the viewer slot always keeps `slotMin` px. */
const VERSIONS = { def: 300, min: 220, max: 420, step: 16, slotMin: 360 };
const VERSIONS_KEY = 'eli5.versionPanel';

function readVersionPanel(): { open: boolean; width: number } {
  try {
    const v = JSON.parse(window.localStorage.getItem(VERSIONS_KEY) ?? 'null') as unknown;
    if (v && typeof v === 'object') {
      const o = v as { open?: unknown; width?: unknown };
      return {
        open: o.open === true,
        width: typeof o.width === 'number' && Number.isFinite(o.width) ? clampVersions(o.width) : VERSIONS.def,
      };
    }
  } catch {
    // per-viewer convenience only
  }
  return { open: false, width: VERSIONS.def };
}

const clampVersions = (w: number) => Math.round(Math.min(VERSIONS.max, Math.max(VERSIONS.min, w)));

function Shell() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [keyEpoch, setKeyEpoch] = useState(0);
  const [catalog, setCatalog] = useState<CatalogEntry[] | null>(null);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [organization, setOrganization] = useState<LibraryOrganization>(EMPTY_ORGANIZATION);
  const [route, setRouteState] = useState<UiRoute>({ view: 'welcome' });
  const previous = useRef<UiRoute>({ view: 'welcome' });
  const startupDone = useRef(false);
  const [sidebar, setSidebar] = useState(readSidebar);
  const [winWidth, setWinWidth] = useState(() => window.innerWidth);
  const narrow = winWidth < SIDEBAR.narrow;
  // Below 1000 px the sidebar starts collapsed, but Cmd+\ and Cmd+F can still open it; this
  // override is per narrow spell and never touches the persisted collapsed flag (11 §5.2, §12).
  const [narrowOpen, setNarrowOpen] = useState(false);
  const inputZone = useRef<InputZoneHandle>(null);
  // Resizable input zone + status row (11 §5.1).
  const bottomRow = useRef<HTMLDivElement>(null);
  const bottom = useBottomPanel(bottomRow);
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

  // Folders, Archive and Trash (09 §4.2): pushed on every organization or catalog change.
  useEffect(() => {
    let live = true;
    void window.eli5.library.organization().then((r) => live && r.ok && setOrganization(r.value));
    const off = window.eli5.library.onOrganizationChanged((e) => setOrganization(e.organization));
    return () => {
      live = false;
      off();
    };
  }, []);

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
  // F6 / Shift+F6 pressed inside the viewer: main already focused the app (11 §12).
  useEffect(() => window.eli5.app.onCycleRegion((e) => cycleRegion(e.dir, 'viewer')), []);

  const openSettings = useCallback((section?: SettingsSection) => go({ view: 'settings', section }), [go]);
  const leaveSettings = useCallback(() => go(previous.current), [go]);
  const openDoc = useCallback((slug: string) => go({ view: 'doc', slug }), [go]);
  const openTrash = useCallback(() => go({ view: 'trash' }), [go]);

  const resolved = resolveRoute(route, catalog);
  const shown: UiRoute =
    resolved.view === 'doc' && missing.has(resolved.slug) ? { view: 'not-found', slug: resolved.slug } : resolved;
  const selectedSlug = shown.view === 'doc' ? shown.slug : null;
  // A missing document that is in the Trash offers Put Back instead of "files are missing" (11 §8).
  const inTrash = shown.view === 'not-found' ? organization.trash.find((t) => t.topicSlug === shown.slug) : undefined;

  // ---- sidebar: collapse (Cmd+\), resize, auto-collapse below 1000 px (11 §5.2, §12) ----
  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_KEY, JSON.stringify(sidebar));
    } catch {
      // per-viewer convenience only
    }
  }, [sidebar]);
  useEffect(() => {
    const onResize = () => setWinWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  useEffect(() => {
    if (!narrow) setNarrowOpen(false);
  }, [narrow]);
  const collapsed = narrow ? !narrowOpen : sidebar.collapsed;
  const narrowRef = useRef(narrow);
  narrowRef.current = narrow;

  // ---- Versions panel: toggle (header, Cmd+Y, View > Show Versions), resize, narrow hint (11 §5.7) ----
  const [versionPanel, setVersionPanel] = useState(readVersionPanel);
  const [versionsHint, setVersionsHint] = useState(false);
  const [versionTree, setVersionTree] = useVersionTree(selectedSlug);
  useEffect(() => {
    try {
      window.localStorage.setItem(VERSIONS_KEY, JSON.stringify(versionPanel));
    } catch {
      // per-viewer convenience only
    }
  }, [versionPanel]);
  // The panel never makes room by collapsing another panel: it shrinks to fit, or stays closed.
  const versionsRoom = winWidth - (collapsed ? 0 : sidebar.width) - VERSIONS.slotMin;
  const versionsFit = versionsRoom >= VERSIONS.min;
  const versionsShown = versionPanel.open && versionsFit && selectedSlug !== null;
  const versionsWidth = Math.min(versionPanel.width, versionsRoom);
  useEffect(() => {
    if (versionsFit) setVersionsHint(false);
  }, [versionsFit]);
  const versionsRef = useRef({ panel: versionPanel, fit: versionsFit });
  versionsRef.current = { panel: versionPanel, fit: versionsFit };

  // ---- shortcuts (11 §9) ----
  const catalogRef = useRef(catalog);
  catalogRef.current = catalog;
  const selectedRef = useRef(selectedSlug);
  selectedRef.current = selectedSlug;
  const routeRef = useRef(route);
  routeRef.current = route;
  const toggleVersions = useCallback(() => {
    if (!selectedRef.current) return;
    const { panel, fit } = versionsRef.current;
    if (panel.open || fit) setVersionPanel({ ...panel, open: !panel.open });
    setVersionsHint(!panel.open && !fit);
  }, []);

  // ---- find in document (11 §5.3 find bar, §9) ----
  // The bar belongs to the document on screen: another document, or any other route, closes it.
  // The last query survives so Cmd+F reopens the bar with it selected.
  const [findOpen, setFindOpen] = useState(false);
  const findBar = useRef<FindBarHandle>(null);
  const findQuery = useRef('');
  useEffect(() => setFindOpen(false), [selectedSlug]);
  const closeFind = useCallback(() => {
    setFindOpen(false);
    void window.eli5.viewer.focus();
  }, []);

  const focusFilter = useCallback(() => {
    if (narrowRef.current) setNarrowOpen(true);
    else setSidebar((s) => ({ ...s, collapsed: false }));
    requestAnimationFrame(() => filterRef.current?.focus());
  }, []);

  /** Cmd+F / Cmd+G / Shift+Cmd+G / Option+Cmd+F, from a key here or the Edit > Find menu. */
  const runFind = useCallback(
    (command: FindCommand) => {
      if (command === 'find-in-library') {
        focusFilter();
        return;
      }
      if (!selectedRef.current) {
        // No document on screen (welcome, Settings, Trash): Cmd+F finds in the Library instead.
        if (command === 'find') focusFilter();
        return;
      }
      const bar = findBar.current;
      if (!bar) {
        // Opening runs the previous query, if any, from the first match.
        setFindOpen(true);
        return;
      }
      if (command === 'find') bar.focus();
      else if (command === 'find-next') bar.next();
      else bar.previous();
    },
    [focusFilter],
  );
  useEffect(() => window.eli5.app.onFindCommand((e) => runFind(e.command)), [runFind]);

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
        case 'toggle-versions':
          toggleVersions();
          break;
        case 'find':
        case 'find-next':
        case 'find-previous':
          runFind(m.id);
          break;
        case 'focus-filter':
          runFind('find-in-library');
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
  }, [leaveSettings, openDoc, openSettings, runFind, toggleVersions]);

  const layoutKey = `${collapsed ? 0 : sidebar.width}:${findOpen ? 1 : 0}:${bottom.height ?? 'auto'}:${versionsShown ? versionsWidth : 0}`;
  const style = useMemo(
    () => ({ '--sidebar-w': collapsed ? '0px' : `${sidebar.width}px` }) as CSSProperties,
    [collapsed, sidebar.width],
  );
  const entry = selectedSlug ? catalog?.find((e) => e.topicSlug === selectedSlug) : undefined;

  return (
    <div className={`shell${collapsed ? ' sidebar-collapsed' : ''}`} style={style}>
      <div className="titlebar-drag" aria-hidden="true" />
      <TopStatus />
      <aside className="sidebar" data-region="sidebar" hidden={collapsed}>
        <LibrarySidebar
          entries={catalog}
          organization={organization}
          error={libraryError}
          selectedSlug={selectedSlug}
          trashSelected={shown.view === 'trash'}
          onOpen={openDoc}
          onOpenTrash={openTrash}
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
        <PanelHandle
          side="left"
          className="sidebar-handle"
          label="Resize sidebar"
          width={sidebar.width}
          min={SIDEBAR.min}
          max={SIDEBAR.max}
          step={SIDEBAR.step}
          onChange={(w) => setSidebar((s) => ({ ...s, width: clampSidebar(w) }))}
        />
      )}
      <div className="main-col">
        <main className="viewer-area" data-region="viewer" tabIndex={-1} aria-label="Viewer">
          {shown.view === 'doc' && (
            <>
              <DocHeader
                slug={shown.slug}
                entry={entry}
                versions={{
                  open: versionsShown,
                  count: versionTree?.nodes.length ?? 0,
                  hint: (versionPanel.open || versionsHint) && !versionsFit,
                  onToggle: toggleVersions,
                }}
              />
              {openError?.slug === shown.slug && (
                <p className="inline-error open-error" role="alert">
                  {openError.message}{' '}
                  <button type="button" onClick={() => openInViewer(shown.slug)}>
                    Retry
                  </button>
                </p>
              )}
              {findOpen && (
                <FindBar
                  handle={findBar}
                  initialQuery={findQuery.current}
                  onQueryChange={(q) => (findQuery.current = q)}
                  onClose={closeFind}
                />
              )}
              <div className="viewer-body">
                <ViewerSlot slug={shown.slug} layoutKey={layoutKey} />
                {versionsShown && (
                  <>
                    <PanelHandle
                      side="right"
                      className="panel-handle panel-handle-right"
                      label="Resize versions panel"
                      width={versionsWidth}
                      min={VERSIONS.min}
                      max={Math.min(VERSIONS.max, versionsRoom)}
                      step={VERSIONS.step}
                      onChange={(w) =>
                        setVersionPanel((v) => ({ ...v, width: clampVersions(Math.min(w, versionsRoom)) }))
                      }
                    />
                    <VersionTreePanel
                      slug={shown.slug}
                      tree={versionTree}
                      width={versionsWidth}
                      onTree={setVersionTree}
                      onClose={() => setVersionPanel((v) => ({ ...v, open: false }))}
                    />
                  </>
                )}
              </div>
            </>
          )}
          {shown.view === 'welcome' && (
            <Welcome hasKey={hasKey} libraryEmpty={!catalog?.length} onAddKey={() => openSettings('ai')} />
          )}
          {shown.view === 'not-found' &&
            (inTrash ? <InTrash item={inTrash} onRestored={(slug) => openDoc(slug)} /> : <NotFound />)}
          {shown.view === 'trash' && <TrashView organization={organization} />}
          {shown.view === 'settings' && (
            <SettingsScreen
              settings={settings}
              section={shown.section}
              onKeyChanged={() => setKeyEpoch((n) => n + 1)}
            />
          )}
        </main>
        <BottomHandle panel={bottom} />
        <div
          className={`bottom-row${bottom.height === null ? '' : ' sized'}`}
          ref={bottomRow}
          style={bottom.height === null ? undefined : { height: `${bottom.height}px` }}
        >
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

/**
 * F6 / Shift+F6: sidebar → viewer → versions (when open) → input zone → status → suggestions (11 §9, §12). `from` names
 * the region focus is leaving when it was the viewer view, whose focus the app cannot see. With a
 * document shown, entering the viewer region focuses the view itself; the doc runtime then moves
 * focus to its active tab.
 */
function cycleRegion(dir: 1 | -1, from?: 'viewer'): void {
  const order = ['sidebar', 'viewer', 'versions', 'input', 'status', 'suggestions'];
  const regions = order
    .map((r) => document.querySelector<HTMLElement>(`[data-region="${r}"]`))
    .filter((el): el is HTMLElement => !!el && !el.closest('[hidden]') && el.childElementCount > 0);
  if (regions.length === 0) return;
  // The Versions panel sits inside the viewer region, so it wins when it holds focus.
  const inVersions = regions.findIndex((r) => r.dataset.region === 'versions' && r.contains(document.activeElement));
  const current =
    !from && inVersions >= 0
      ? inVersions
      : regions.findIndex((r) => (from ? r.dataset.region === from : r.contains(document.activeElement)));
  const next = regions[(current + dir + regions.length) % regions.length];
  if (next?.dataset.region === 'viewer' && next.querySelector('[data-testid="viewer-slot"]')) {
    next.focus();
    void window.eli5.viewer.focus();
    return;
  }
  const target =
    next?.querySelector<HTMLElement>('[role="treeitem"][tabindex="0"]') ??
    next?.querySelector<HTMLElement>('button, input, textarea, [tabindex="0"], [tabindex="-1"]') ??
    next ??
    null;
  target?.focus();
}
