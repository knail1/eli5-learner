import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { DocVersionNode, DocVersionTree } from '../../../preload/contract';
import { relativeDate } from '../library/order';
import { layoutVersionTree, pendingVerb, versionVerb, type VersionRow } from './version-tree-layout';

/**
 * Versions panel (11 §5.7, PRD *Versions*): the open document's versions as a WAI-ARIA tree. A
 * click, Enter or Space opens a version through `eli5:doc:checkout`; main reloads the viewer and
 * lands on where that version changed. Every version is kept, so there are no confirms.
 */

const BUSY_LINE = 'Wait for the update to finish';
const PRUNED = 'That version is no longer available';
const TYPEAHEAD_MS = 600;

/**
 * The open document's version tree: `eli5:doc:versions` on slug change, then
 * `eli5:doc:versions-changed` for that slug. Answers for a previous slug are dropped (the
 * HistoryButtons pattern). The setter also ignores trees for another slug.
 */
export function useVersionTree(slug: string | null): [DocVersionTree | null, (t: DocVersionTree) => void] {
  const [tree, setTree] = useState<DocVersionTree | null>(null);
  const slugRef = useRef(slug);
  slugRef.current = slug;

  useEffect(() => {
    setTree(null);
    if (!slug) return;
    let live = true;
    window.eli5.doc.versions(slug).then(
      (r) => {
        if (live && r.ok && r.value.slug === slugRef.current) setTree(r.value);
      },
      () => {
        // The panel keeps its loading line; the next versions-changed push fills it.
      },
    );
    const off = window.eli5.doc.onVersionsChanged((e) => {
      if (live && e.slug === slugRef.current) setTree(e.tree);
    });
    return () => {
      live = false;
      off();
    };
  }, [slug]);

  const set = useCallback((t: DocVersionTree) => {
    if (t.slug === slugRef.current) setTree(t);
  }, []);
  return [tree, set];
}

/** "just now", "5m ago", "3d ago", "Mar 4". */
function ago(iso: string): string {
  const r = relativeDate(iso);
  if (r === 'now') return 'just now';
  return /^\d+[mhdw]$/.test(r) ? `${r} ago` : r;
}

function errorText(err: unknown): string {
  return err instanceof Error && err.message ? err.message : 'Something went wrong. Try again.';
}

function rowDisabled(row: VersionRow, blocked: boolean): boolean {
  return blocked || !row.node.available;
}

export function VersionTreePanel(p: {
  slug: string;
  tree: DocVersionTree | null;
  width: number;
  onTree(t: DocVersionTree): void;
  onClose(): void;
}) {
  const { tree } = p;
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [checkingOut, setCheckingOut] = useState<string | null>(null);
  const [stepping, setStepping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const slugRef = useRef(p.slug);
  slugRef.current = p.slug;
  const items = useRef(new Map<string, HTMLLIElement>());
  const typeahead = useRef({ text: '', at: 0 });
  // Versions seen for this slug, so only new ones fade in (none on first load).
  const known = useRef<{ slug: string; ids: Set<string> } | null>(null);

  useEffect(() => {
    setCollapsed(new Set());
    setFocusedId(null);
    setError(null);
    setCheckingOut(null);
  }, [p.slug]);

  const rows = useMemo(() => (tree ? layoutVersionTree(tree, collapsed) : []), [tree, collapsed]);
  const byId = useMemo(() => new Map(tree?.nodes.map((n) => [n.id, n]) ?? []), [tree]);

  // Computed once per tree, so a re-render (focus, collapse) does not cut a fade short.
  const fresh = useMemo(() => {
    const out = new Set<string>();
    if (!tree) return out;
    const prev = known.current;
    if (prev?.slug === tree.slug) for (const n of tree.nodes) if (!prev.ids.has(n.id)) out.add(n.id);
    known.current = { slug: tree.slug, ids: new Set(tree.nodes.map((n) => n.id)) };
    return out;
  }, [tree]);

  const busy = !!tree?.busy;
  const readOnly = !!tree?.readOnly;
  const blocked = busy || readOnly || checkingOut !== null || stepping;
  const current = tree ? byId.get(tree.currentId) : undefined;
  const forward = tree?.redoId ? byId.get(tree.redoId) : undefined;
  const canBack = !!current?.parentId && byId.get(current.parentId)?.available === true && !blocked;
  const canForward = !!forward?.available && !blocked;

  const inRows = (id: string | null | undefined): id is string => !!id && rows.some((r) => r.node.id === id);
  const currentId = tree?.currentId;
  const activeId = inRows(focusedId) ? focusedId : inRows(currentId) ? currentId : rows[0]?.node.id;
  const focused = activeId ? byId.get(activeId) : undefined;

  const moveTo = (id: string | undefined) => {
    if (!id) return;
    setFocusedId(id);
    items.current.get(id)?.focus();
  };

  const open = async (row: VersionRow) => {
    if (!row.node.available) {
      setError(PRUNED);
      return;
    }
    if (rowDisabled(row, blocked)) return;
    const slug = slugRef.current;
    setCheckingOut(row.node.id);
    setError(null);
    try {
      const r = await window.eli5.doc.checkout(slug, row.node.id);
      if (slugRef.current !== slug) return;
      if (r.ok) p.onTree(r.value);
      else setError(r.error.message);
    } catch (err) {
      if (slugRef.current === slug) setError(errorText(err));
    } finally {
      setCheckingOut(null);
    }
  };

  const step = async (dir: 'undo' | 'redo') => {
    const slug = slugRef.current;
    setStepping(true);
    setError(null);
    try {
      const r = await (dir === 'undo' ? window.eli5.doc.undo(slug) : window.eli5.doc.redo(slug));
      if (slugRef.current === slug && !r.ok) setError(r.error.message);
    } catch (err) {
      if (slugRef.current === slug) setError(errorText(err));
    } finally {
      setStepping(false);
    }
  };

  const toggle = (row: VersionRow, expand: boolean) =>
    setCollapsed((c) => {
      const next = new Set(c);
      if (expand) next.delete(row.node.id);
      else next.add(row.node.id);
      return next;
    });

  const onKeyDown = (e: ReactKeyboardEvent<HTMLUListElement>) => {
    const at = rows.findIndex((r) => r.node.id === activeId);
    const row = rows[at];
    if (!row) return;
    let handled = true;
    switch (e.key) {
      case 'ArrowDown':
        moveTo(rows[at + 1]?.node.id);
        break;
      case 'ArrowUp':
        moveTo(rows[at - 1]?.node.id);
        break;
      case 'Home':
        moveTo(rows[0]?.node.id);
        break;
      case 'End':
        moveTo(rows[rows.length - 1]?.node.id);
        break;
      case 'ArrowRight':
        if (row.hasChildren && !row.expanded) toggle(row, true);
        else if (row.hasChildren) moveTo(rows.find((r) => r.groupId === row.node.id)?.node.id);
        break;
      case 'ArrowLeft':
        if (row.hasChildren && row.expanded && !row.forced) toggle(row, false);
        else if (row.groupId) moveTo(row.groupId);
        break;
      case 'Enter':
      case ' ':
        void open(row);
        break;
      default:
        handled = false;
        if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
          const now = Date.now();
          const t = typeahead.current;
          t.text = (now - t.at > TYPEAHEAD_MS ? '' : t.text) + e.key.toLowerCase();
          t.at = now;
          const order = [...rows.slice(at + (t.text.length === 1 ? 1 : 0)), ...rows.slice(0, at + 1)];
          const hit = order.find((r) => r.node.topic.toLowerCase().startsWith(t.text));
          if (hit) moveTo(hit.node.id);
          handled = true;
        }
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  // Rows grouped by the branch point that owns them; pending rows sit under the current version.
  const groups = new Map<string | null, VersionRow[]>();
  for (const r of rows) groups.set(r.groupId, [...(groups.get(r.groupId) ?? []), r]);

  const renderGroup = (owner: string | null) =>
    (groups.get(owner) ?? []).map((row) => {
      const n = row.node;
      const disabled = rowDisabled(row, blocked);
      const cls = [
        'version-item',
        row.onCurrentPath ? 'on-path' : 'off-path',
        row.isCurrent ? 'current' : '',
        row.branchStart ? 'branch-start' : '',
        row.laneEnd ? 'lane-end' : '',
        n.available ? '' : 'pruned',
        fresh.has(n.id) ? 'version-new' : '',
      ]
        .filter(Boolean)
        .join(' ');
      return (
        <li
          key={n.id}
          ref={(el) => {
            if (el) items.current.set(n.id, el);
            else items.current.delete(n.id);
          }}
          className={cls}
          role="treeitem"
          data-id={n.id}
          aria-level={row.level}
          aria-setsize={row.setsize}
          aria-posinset={row.posinset}
          aria-expanded={row.hasChildren ? row.expanded : undefined}
          aria-current={row.isCurrent ? 'true' : undefined}
          aria-disabled={disabled || undefined}
          aria-busy={checkingOut === n.id || undefined}
          tabIndex={n.id === activeId ? 0 : -1}
          onFocus={(e) => {
            if (e.target === e.currentTarget) setFocusedId(n.id);
          }}
        >
          <div
            className="version-row"
            onClick={() => {
              moveTo(n.id);
              void open(row);
            }}
          >
            <span className="version-dot" aria-hidden="true" />
            <span className="version-text">
              <span className="version-topic">{n.topic || n.label}</span>
              <span className="version-meta muted">
                {versionVerb(n)} · {ago(n.createdAt)}
              </span>
              {n.kind === 'ask' && n.question && <span className="version-question">“{n.question}”</span>}
              <span className="version-chips">
                {row.isCurrent && <span className="version-chip">Current</span>}
                {n.published && <span className="version-chip">Published</span>}
                {!n.available && <span className="version-chip">(snapshot removed)</span>}
                {checkingOut === n.id && <span className="spinner" aria-label="Opening" />}
              </span>
            </span>
          </div>
          {row.hasChildren && row.expanded && (
            <ul role="group" className="version-group">
              {renderGroup(n.id)}
            </ul>
          )}
          {row.isCurrent &&
            tree?.pending.map((pd, i) => (
              <div key={`pending-${i}`} className="version-pending muted" aria-hidden="true">
                {pendingVerb(pd)} · {pd.heading}
              </div>
            ))}
        </li>
      );
    });

  const pendingText = tree?.pending.map((pd) => `${pendingVerb(pd)} ${pd.heading}`).join('; ');

  return (
    <aside
      id="version-panel"
      className="version-panel"
      data-region="versions"
      aria-label="Versions"
      style={{ width: `${p.width}px` }}
    >
      <div className="version-header">
        <h2>Versions</h2>
        <div className="version-nav">
          <button
            type="button"
            aria-label="Back to previous version"
            title={current ? `Back: undo ${current.label}` : undefined}
            disabled={!canBack}
            onClick={() => void step('undo')}
          >
            <span aria-hidden="true">←</span> Back
          </button>
          <button
            type="button"
            aria-label="Forward to next version"
            title={forward ? `Forward: ${forward.label}` : undefined}
            disabled={!canForward}
            onClick={() => void step('redo')}
          >
            Forward <span aria-hidden="true">→</span>
          </button>
          <button type="button" onClick={p.onClose}>
            Close
          </button>
        </div>
      </div>
      <div className="version-banners" aria-live="polite">
        {tree?.detached && (
          <p className="version-banner">
            This document changed outside the app; it will be saved as a version on the next change.
          </p>
        )}
        {tree?.degraded && <p className="version-banner">Version history couldn’t be saved for the last change.</p>}
        {busy && <p className="version-busy muted">{BUSY_LINE}</p>}
        {pendingText && <span className="visually-hidden">{pendingText}</span>}
      </div>
      {tree === null ? (
        <p className="muted version-loading">Loading versions…</p>
      ) : (
        <ul role="tree" aria-label="Document versions" className="version-tree" onKeyDown={onKeyDown}>
          {renderGroup(null)}
        </ul>
      )}
      <footer className="version-footer">
        {focused && <VersionDetail node={focused} />}
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
      </footer>
    </aside>
  );
}

/** The focused row's full label, heading and question (no native tooltips, 11 §5.7). */
function VersionDetail(p: { node: DocVersionNode }) {
  const n = p.node;
  return (
    <div className="version-detail">
      <p>{n.label}</p>
      {n.heading && <p className="muted">Section: {n.heading}</p>}
      {n.question && <p className="muted">Question: “{n.question}”</p>}
    </div>
  );
}
