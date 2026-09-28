import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  IpcError,
  IpcResult,
  PublishLink,
  PublishResult,
  PublishStage,
  PublishTarget,
  SecretFinding,
  UiFeature,
} from '../../../preload/contract';
import { useEdition } from '../edition/FeatureGate';
import { relativeDate } from '../library/order';

/**
 * Publish slot in the document header (11 §5.3, §11; 10 §7). The public slot holds only Export
 * copy for the `local` target; drive and git targets are mounted only when HOOK-UI-01 enables
 * their UiFeature. Progress, Cancel, the result chip, "Last published" and failures render inline;
 * nothing here is a modal.
 */

const FEATURE_FOR: Record<PublishTarget['kind'], UiFeature | null> = {
  local: null,
  drive: 'publish.drive',
  git: 'publish.git',
};

const STAGE_TEXT: Record<PublishStage, string> = {
  preparing: 'Preparing…',
  scanning: 'Checking for secrets…',
  uploading: 'Uploading…',
  sharing: 'Sharing…',
  committing: 'Committing…',
  pushing: 'Pushing…',
  'waiting-for-site': 'Waiting for the site…',
  done: 'Done',
};

const COPIED_MS = 2000;

/** 10 §7 step 1: link text truncated in the middle so both the host and the file stay visible. */
export function truncateMiddle(s: string, max = 48): string {
  if (s.length <= max) return s;
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  return `${s.slice(0, head)}…${s.slice(s.length - (keep - head))}`;
}

/** A `file:` link reads as its decoded path; anything else as the URL. */
export function linkText(url: string): string {
  try {
    const u = new URL(url);
    if (u.protocol === 'file:') return decodeURIComponent(u.pathname);
  } catch {
    // not a URL: show it as is
  }
  return url;
}

const isFileLink = (url: string) => url.startsWith('file:');
const buttonLabel = (t: PublishTarget) => (t.kind === 'local' ? 'Export copy' : t.label);

interface Outcome {
  targetId: string;
  label: string;
  result: PublishResult;
}

type Failure = Pick<IpcError, 'message' | 'detailCode' | 'findings'>;

function LinkActions(p: { url: string; copied: boolean; act: (a: 'copy' | 'open' | 'reveal', url: string) => void }) {
  return (
    <>
      <button type="button" onClick={() => p.act('copy', p.url)}>
        Copy link
      </button>
      {p.copied && (
        <span className="muted" role="status">
          Copied
        </span>
      )}
      <button type="button" onClick={() => p.act('open', p.url)}>
        Open
      </button>
      {isFileLink(p.url) && (
        <button type="button" onClick={() => p.act('reveal', p.url)}>
          Show in Finder
        </button>
      )}
    </>
  );
}

export function PublishControls(p: { slug: string }) {
  const edition = useEdition();
  const [targets, setTargets] = useState<PublishTarget[]>([]);
  const [busy, setBusy] = useState<{ targetId: string; stage: PublishStage | null } | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  // The header stays mounted across documents; async results apply only to the slug that asked.
  const slugRef = useRef(p.slug);
  slugRef.current = p.slug;
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const refresh = useCallback((slug: string) => {
    void window.eli5.publish.targets(slug).then((r) => {
      if (slugRef.current === slug && r.ok) setTargets(r.value);
    });
  }, []);

  useEffect(() => {
    setTargets([]);
    setBusy(null);
    setOutcome(null);
    setFailure(null);
    setCopied(null);
    refresh(p.slug);
  }, [p.slug, refresh]);

  // "Changed since last publish" follows regenerations (10 §4): re-describe on Library changes.
  useEffect(() => window.eli5.library.onChanged(() => refresh(slugRef.current)), [refresh]);

  useEffect(
    () =>
      window.eli5.publish.onProgress((e) => {
        if (e.slug !== slugRef.current || e.stage === 'failed' || e.stage === 'done') return;
        const stage = e.stage;
        setBusy((b) => (b && b.targetId === e.targetId ? { ...b, stage } : b));
      }),
    [],
  );

  useEffect(() => () => clearTimeout(copiedTimer.current), []);

  const visible = targets.filter((t) => {
    if (!t.available) return false;
    const f = FEATURE_FOR[t.kind];
    return f === null ? t.kind === 'local' : !!edition?.uiFeatures.includes(f);
  });

  const run = async (t: PublishTarget) => {
    const slug = p.slug;
    setBusy({ targetId: t.id, stage: null });
    setFailure(null);
    setOutcome(null);
    const r = await window.eli5.publish.run(slug, t.id);
    if (slugRef.current !== slug) return;
    setBusy(null);
    if (r.ok) {
      setOutcome({ targetId: t.id, label: buttonLabel(t), result: r.value });
      refresh(slug);
    } else {
      setFailure(r.error);
    }
  };

  const act = async (a: 'copy' | 'open' | 'reveal', url: string) => {
    const slug = p.slug;
    const call: Record<typeof a, (u: string) => Promise<IpcResult<void>>> = {
      copy: window.eli5.publish.copyLink,
      open: window.eli5.publish.openLink,
      reveal: window.eli5.publish.reveal,
    };
    const r = await call[a](url);
    if (slugRef.current !== slug) return;
    if (!r.ok) {
      setFailure(r.error);
      return;
    }
    setFailure(null);
    if (a === 'copy') {
      setCopied(url);
      clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(null), COPIED_MS);
    }
  };
  const onAct = (a: 'copy' | 'open' | 'reveal', url: string) => void act(a, url);

  const primary: PublishLink | undefined = outcome?.result.links.find((l) => l.primary) ?? outcome?.result.links[0];
  const history = visible.filter((t) => t.lastPublished && t.id !== outcome?.targetId);

  return (
    <>
      {visible.length > 0 && (
        <div className="doc-actions publish-controls">
          {visible.map((t) => (
            <button
              key={t.id}
              type="button"
              disabled={busy !== null}
              onClick={() => void run(t)}
              aria-busy={busy?.targetId === t.id}
            >
              {busy?.targetId === t.id ? <span className="spinner" aria-hidden="true" /> : null}
              {buttonLabel(t)}
            </button>
          ))}
          {busy && (
            <>
              <span className="muted" role="status">
                {busy.stage ? STAGE_TEXT[busy.stage] : ''}
              </span>
              <button type="button" onClick={() => void window.eli5.publish.cancel(p.slug, busy.targetId)}>
                Cancel
              </button>
            </>
          )}
        </div>
      )}
      {outcome && primary && (
        <div className="result-chip" role="group" aria-label={`${outcome.label} result`}>
          <span className="muted">{outcome.label}:</span>
          <span className="chip-link" title={primary.url}>
            {truncateMiddle(linkText(primary.url))}
          </span>
          <LinkActions url={primary.url} copied={copied === primary.url} act={onAct} />
        </div>
      )}
      {outcome?.result.warnings.map((w) => (
        <p key={w} className="inline-hint muted">
          {w}
        </p>
      ))}
      {history.map((t) => {
        const last = t.lastPublished;
        if (!last) return null;
        return (
          <div key={t.id} className="result-chip last-published" role="group" aria-label={`${buttonLabel(t)} history`}>
            <span className="muted" title={last.publishedAt}>
              Last published {relativeLabel(last.publishedAt)}
              {t.changedSincePublish ? ' · Changed since last publish' : ''}
            </span>
            <LinkActions url={last.primaryUrl} copied={copied === last.primaryUrl} act={onAct} />
          </div>
        );
      })}
      {failure && <FailureView failure={failure} signIn={!!edition?.uiFeatures.includes('auth.signIn')} />}
    </>
  );
}

/** "3d ago" / "just now" / "Mar 4" (the sidebar's compact dates, 11 §5.2). */
function relativeLabel(iso: string): string {
  const r = relativeDate(iso);
  if (r === 'now') return 'just now';
  return /^\d+[mhdw]$/.test(r) ? `${r} ago` : r;
}

/** 10 §7 step 5: message plus at most one action; secret findings are listed, masked. */
function FailureView(p: { failure: Failure; signIn: boolean }) {
  const { message, detailCode, findings } = p.failure;
  return (
    <div className="inline-error" role="alert">
      <p className="inline-error">{message}</p>
      {detailCode === 'E_PUBLISH_SECRET_FOUND' && findings && findings.length > 0 && (
        <ul className="publish-findings">
          {findings.map((f: SecretFinding) => (
            <li key={`${f.relPath}:${f.line}:${f.rule}`}>{`${f.relPath} line ${f.line}: ${f.rule} ${f.preview}`}</li>
          ))}
        </ul>
      )}
      {detailCode === 'E_PUBLISH_SIGN_IN_REQUIRED' && p.signIn && (
        <button type="button" onClick={() => void window.eli5.auth.signIn()}>
          Sign in
        </button>
      )}
    </div>
  );
}
