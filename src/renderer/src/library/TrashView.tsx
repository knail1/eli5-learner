import { useEffect, useRef, useState } from 'react';
import type { LibraryOrganization, TrashItem } from '../../../preload/contract';
import { useAnnounce } from '../a11y/Announcer';
import { trashDetail } from './organize';

/**
 * The Trash (11 §5.2, 09 §4.2), shown in the viewer area. Put Back returns a document to where it
 * was; Delete Permanently and Empty Trash are the only irreversible steps, so each asks once in an
 * inline confirmation (never a modal).
 */

const plural = (n: number) => `${n} ${n === 1 ? 'document' : 'documents'}`;

export function TrashView(p: { organization: LibraryOrganization }) {
  const announce = useAnnounce();
  const items = p.organization.trash;
  // 'empty' or a trashId awaiting confirmation.
  const [confirm, setConfirm] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async <T,>(
    fn: () => Promise<{ ok: true; value: T } | { ok: false; error: { message: string } }>,
  ): Promise<{ value: T } | undefined> => {
    setBusy(true);
    setError(null);
    try {
      const r = await fn();
      if (!r.ok) setError(r.error.message);
      return r.ok ? { value: r.value } : undefined;
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };

  const putBack = async (t: TrashItem) => {
    if (await run(() => window.eli5.library.putBack(t.trashId))) announce(`Put back “${t.title}”`);
  };
  const deleteOne = async (t: TrashItem) => {
    if (await run(() => window.eli5.library.deletePermanently(t.trashId))) {
      announce(`Deleted “${t.title}” permanently`);
    }
  };
  const empty = async () => {
    const r = await run(() => window.eli5.library.emptyTrash());
    if (r) announce(`Emptied the Trash: ${plural(r.value.deleted)} deleted`);
  };

  return (
    <section className="trash-view" aria-labelledby="trash-title">
      <header className="trash-head">
        <h1 id="trash-title">Trash</h1>
        <button type="button" disabled={items.length === 0 || busy} onClick={() => setConfirm('empty')}>
          Empty Trash
        </button>
      </header>
      <p className="muted">
        Documents in the Trash stay recoverable for {p.organization.trashRetentionDays} days, then are deleted.
      </p>
      {confirm === 'empty' && (
        <Confirm
          text={`Permanently delete ${plural(items.length)} in the Trash? This can’t be undone.`}
          action="Empty Trash"
          onConfirm={() => void empty()}
          onCancel={() => setConfirm(null)}
        />
      )}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      {items.length === 0 ? (
        <p className="empty">The Trash is empty</p>
      ) : (
        <ul className="trash-list" aria-label="Documents in the Trash">
          {items.map((t) => (
            <li key={t.trashId} className="trash-item">
              <div className="trash-text">
                <span className="item-title">{t.title}</span>
                <span className="muted trash-detail">{trashDetail(t)}</span>
              </div>
              <div className="row">
                <button type="button" disabled={busy} onClick={() => void putBack(t)}>
                  Put Back
                </button>
                <button type="button" disabled={busy} onClick={() => setConfirm(t.trashId)}>
                  Delete Permanently
                </button>
              </div>
              {confirm === t.trashId && (
                <Confirm
                  text={`Delete “${t.title}” permanently? This can’t be undone.`}
                  action="Delete"
                  onConfirm={() => void deleteOne(t)}
                  onCancel={() => setConfirm(null)}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Inline, non-modal confirmation; focus starts on Cancel and Escape cancels. */
function Confirm(p: { text: string; action: string; onConfirm(): void; onCancel(): void }) {
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => cancel.current?.focus(), []);
  return (
    <div
      className="confirm"
      role="group"
      aria-label="Confirm"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          p.onCancel();
        }
      }}
    >
      <p>{p.text}</p>
      <div className="row">
        <button ref={cancel} type="button" onClick={p.onCancel}>
          Cancel
        </button>
        <button type="button" className="danger" onClick={p.onConfirm}>
          {p.action}
        </button>
      </div>
    </div>
  );
}

/** A document route whose slug is in the Trash (a notification, the tray, a stale link): offer Put Back. */
export function InTrash(p: { item: TrashItem; onRestored(slug: string): void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <section className="welcome" aria-labelledby="in-trash-title">
      <h1 id="in-trash-title">This document is in the Trash.</h1>
      <p className="muted">
        “{p.item.title}” · {trashDetail(p.item)}
      </p>
      <p>
        <button
          type="button"
          className="primary"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void window.eli5.library.putBack(p.item.trashId).then((r) => {
              setBusy(false);
              if (r.ok) p.onRestored(r.value.slug);
              else setError(r.error.message);
            });
          }}
        >
          Put Back
        </button>
      </p>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
