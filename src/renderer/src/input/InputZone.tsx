import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type KeyboardEvent,
  type Ref,
} from 'react';
import type { JobStatus, ProviderId, SourceInput } from '../../../preload/contract';
import { useAnnounce } from '../a11y/Announcer';
import {
  RESTART_TOOLTIP,
  URL_INVALID_MESSAGE,
  chipIcon,
  chipLabel,
  clarifyRows,
  commitUrlText,
  draftHasContent,
  fileInput,
  filesToRelease,
  isHttpUrl,
  isStaged,
  isTextField,
  newDraft,
  resolveDropPaths,
  splitTokens,
  startErrorMessage,
  startMode,
  startRequest,
  type DraftRun,
} from './draft';
import type { InputDraft } from './types';

/**
 * Input zone (11 §5.4): drop box, paste, URL field, chips, clarifying specifics, glossary toggle,
 * Clear, and Start (Restart while the draft's last run is still going). The draft stays after a
 * start so it can be edited and run again. Every message is inline; nothing here opens a modal (11 §1).
 */

export interface InputZoneHandle {
  focusUrl(): void;
  focusDropBox(): void;
  clearDraft(): void;
  /** Same path as a native drop after `files.pathFor` (13 §8.1 test hook). */
  addPaths(paths: string[]): void;
}

export interface InputZoneProps {
  glossaryDefault: boolean;
  provider: ProviderId;
  onOpenSettings(): void;
  ref?: Ref<InputZoneHandle>;
}

type Hint = { text: string; settingsLink?: boolean } | null;

const START_DEBOUNCE_MS = 400;
const HINT_MS = 3000;

export function InputZone(p: InputZoneProps) {
  const announce = useAnnounce();
  const [draft, setDraft] = useState<InputDraft>(() => newDraft(p.glossaryDefault));
  const [glossaryTouched, setGlossaryTouched] = useState(false);
  const [urlError, setUrlError] = useState<string | null>(null);
  const [hint, setHint] = useState<Hint>(null);
  const [startError, setStartError] = useState<Hint>(null);
  const [dragDepth, setDragDepth] = useState(0);
  const [starting, setStarting] = useState(false);
  // The job last started from this draft; Restart cancels it while it is queued or running.
  const [run, setRun] = useState<DraftRun | null>(null);
  const runRef = useRef(run);
  runRef.current = run;
  // Newest status per job from change events, for a run whose events beat jobs.start's answer.
  const statusSeen = useRef(new Map<string, JobStatus>());
  const lastStart = useRef(0);
  // Synchronous guard: taken before the first await so a second Enter during the key check or
  // jobs.start cannot send a duplicate job (11 §5.4 debounce).
  const inFlight = useRef(false);
  const hintTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const dropBox = useRef<HTMLDivElement>(null);
  const urlField = useRef<HTMLInputElement>(null);

  // glossary.defaultOn applies to every new draft; settings arrive asynchronously.
  useEffect(() => {
    if (!glossaryTouched) setDraft((d) => ({ ...d, glossary: p.glossaryDefault }));
  }, [p.glossaryDefault, glossaryTouched]);

  const showHint = useCallback((h: Hint, transient = false) => {
    clearTimeout(hintTimer.current);
    setHint(h);
    if (transient) hintTimer.current = setTimeout(() => setHint(null), HINT_MS);
  }, []);
  useEffect(() => () => clearTimeout(hintTimer.current), []);

  const append = useCallback((inputs: SourceInput[]) => {
    if (inputs.length === 0) return;
    setDraft((d) => ({ ...d, inputs: [...d.inputs, ...inputs] }));
    setHint(null);
    setStartError(null);
  }, []);

  useEffect(
    () =>
      window.eli5.jobs.onChanged((s) => {
        statusSeen.current.set(s.id, s.status);
        setRun((r) => (r && r.jobId === s.id && r.status !== s.status ? { ...r, status: s.status } : r));
      }),
    [],
  );

  const clearDraft = useCallback(() => {
    const d = draftRef.current;
    // The draft's staged pastes and its file registrations go with it (03 §13, 06 §11).
    if (d.inputs.some(isStaged)) void window.eli5.sources.discardDraft(d.draftId);
    const files = filesToRelease(d.inputs, []);
    if (files.length > 0) void window.eli5.sources.release(files);
    setDraft(newDraft(p.glossaryDefault));
    setRun(null);
    setGlossaryTouched(false);
    setUrlError(null);
    setHint(null);
    setStartError(null);
  }, [p.glossaryDefault]);

  const addPaths = useCallback((paths: string[]) => append(paths.filter(Boolean).map((x) => fileInput(x))), [append]);

  useImperativeHandle(
    p.ref,
    () => ({
      focusUrl: () => urlField.current?.focus(),
      focusDropBox: () => dropBox.current?.focus(),
      clearDraft,
      addPaths,
    }),
    [clearDraft, addPaths],
  );

  // ---- drop anywhere over the renderer (the viewer is a native layer and never receives drops) ----
  const acceptDrop = useCallback(
    async (dt: DataTransfer) => {
      const files = Array.from(dt.files);
      if (files.length > 0) {
        const { paths, failed } = resolveDropPaths(files, (f) => window.eli5.files.pathFor(f));
        addPaths(paths);
        if (failed.length > 0) showHint({ text: `Could not add ${failed.join(', ')}` }, true);
        return;
      }
      const uris = dt
        .getData('text/uri-list')
        .split(/\r?\n/)
        .filter((l) => l && !l.startsWith('#') && isHttpUrl(l));
      if (uris.length > 0) {
        append(commitUrlText(uris.join(' '), 'drop').added);
        return;
      }
      const html = dt.getData('text/html');
      const text = dt.getData('text/plain');
      if (!text.trim() && !html.trim()) return;
      const tokens = splitTokens(text);
      if (tokens.length > 0 && tokens.every(isHttpUrl)) {
        append(commitUrlText(text, 'drop').added);
        return;
      }
      const r = await window.eli5.sources.stageText(
        draftRef.current.draftId,
        html.trim() ? html : text,
        html.trim() ? 'html' : 'plain',
      );
      if (r.ok) append([r.value]);
      else showHint({ text: r.error.message }, true);
    },
    [addPaths, append, showHint],
  );

  useEffect(() => {
    const over = (e: DragEvent) => {
      // Always cancel so a dropped file never navigates the app renderer.
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const enter = (e: DragEvent) => {
      e.preventDefault();
      setDragDepth((n) => n + 1);
    };
    const leave = () => setDragDepth((n) => Math.max(0, n - 1));
    const drop = (e: DragEvent) => {
      e.preventDefault();
      setDragDepth(0);
      if (e.dataTransfer) void acceptDrop(e.dataTransfer);
    };
    window.addEventListener('dragover', over);
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  }, [acceptDrop]);

  // Test builds: the preload's dropPaths helper dispatches this after path resolution (13 §8.1).
  useEffect(() => {
    if (!__ELI5_TEST__) return;
    const onTestDrop = (e: Event) => {
      const detail = (e as CustomEvent<unknown>).detail;
      if (Array.isArray(detail)) addPaths(detail.filter((x): x is string => typeof x === 'string'));
    };
    window.addEventListener('eli5:test:drop-paths', onTestDrop);
    return () => window.removeEventListener('eli5:test:drop-paths', onTestDrop);
  }, [addPaths]);

  // ---- paste outside text fields becomes a clipboard source (Cmd+V, 11 §5.4 step 2) ----
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (isTextField(e.target) || isTextField(document.activeElement)) return;
      e.preventDefault();
      void window.eli5.sources.readClipboard(draftRef.current.draftId).then((r) => {
        if (r.ok && r.value.length > 0) append(r.value);
        else showHint({ text: r.ok ? 'Nothing to paste' : r.error.message }, true);
      });
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [append, showHint]);

  // ---- URL field ----
  const onUrlPaste = (e: ReactClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData('text/plain');
    if (splitTokens(text).length < 2) return;
    e.preventDefault();
    const { added, invalid } = commitUrlText(text);
    append(added);
    setDraft((d) => ({ ...d, urlText: invalid.join(' ') }));
    setUrlError(invalid.length ? URL_INVALID_MESSAGE : null);
  };

  const removeInput = (i: SourceInput) => {
    const d = draftRef.current;
    const rest = d.inputs.filter((x) => x.id !== i.id);
    if (isStaged(i)) void window.eli5.sources.discard(d.draftId, i.id);
    const files = filesToRelease([i], rest);
    if (files.length > 0) void window.eli5.sources.release(files);
    setDraft({ ...d, inputs: rest });
  };

  // ---- Start algorithm (11 §5.4) ----
  const start = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      await runStart();
    } finally {
      inFlight.current = false;
    }
  };

  const runStart = async () => {
    // Debounce only real starts against a double Enter; validation hints stay immediate.
    if (Date.now() - lastStart.current < START_DEBOUNCE_MS) return;
    setStartError(null);
    const d = draftRef.current;
    let inputs = d.inputs;
    // 1. Commit URL field text; invalid text blocks the start and keeps focus there.
    if (d.urlText.trim()) {
      const { added, invalid } = commitUrlText(d.urlText);
      inputs = [...inputs, ...added];
      setDraft({ ...d, inputs, urlText: invalid.join(' ') });
      if (invalid.length > 0) {
        setUrlError(URL_INVALID_MESSAGE);
        urlField.current?.focus();
        return;
      }
      setUrlError(null);
    }
    // 2. Clarifying text alone never starts a job.
    if (inputs.length === 0) {
      showHint({ text: 'Add a file, paste, or URL first' });
      return;
    }
    // 3. No key for the selected provider.
    if (p.provider === 'claude' || p.provider === 'openai') {
      const k = await window.eli5.settings.hasApiKey(p.provider);
      if (k.ok && !k.value) {
        showHint({ text: 'Add an API key in Settings to start', settingsLink: true });
        return;
      }
    }
    // 4. Start. A Restart starts the new run first, so a failed start leaves the old run going.
    const previous = runRef.current;
    const restart = startMode(previous) === 'restart' ? previous : null;
    lastStart.current = Date.now();
    setStarting(true);
    const req = startRequest(draftRef.current, inputs);
    const r = await window.eli5.jobs.start(req);
    lastStart.current = Date.now();
    setStarting(false);
    if (r.ok) {
      // 5. The draft stays as it is, for editing and another run; focus stays where it was.
      const jobId = r.value.jobId;
      setRun({ jobId, status: statusSeen.current.get(jobId) ?? 'queued' });
      if (restart) {
        const c = await window.eli5.jobs.cancel(restart.jobId);
        showHint(
          {
            text: c.ok
              ? 'Restarted with these inputs. The earlier run was cancelled'
              : 'Started again. The earlier run could not be stopped and will finish too',
          },
          true,
        );
        announce('Restarted');
      } else {
        showHint({ text: 'Started. Edit and Restart to run it again with changes' }, true);
        announce('Started');
      }
    } else {
      // 6. Keep the draft intact (and any earlier run going). A key missing at start time (01 §6.2) links to Settings like step 3.
      setStartError({ text: startErrorMessage(r.error), settingsLink: r.error.code === 'E_NO_API_KEY' });
    }
  };

  const enterStarts = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    void start();
  };

  const onZoneKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Escape' && (hint || urlError || startError)) {
      e.stopPropagation();
      setHint(null);
      setStartError(null);
    }
  };

  const dragging = dragDepth > 0;
  const mode = startMode(run);

  return (
    <form
      className={`input-zone${dragging ? ' dragging' : ''}`}
      aria-label="New explainer"
      onSubmit={(e) => e.preventDefault()}
      onKeyDown={onZoneKey}
    >
      <div
        ref={dropBox}
        className="drop-box"
        tabIndex={0}
        role="group"
        aria-label="Sources. Drop files, paste, or add a URL"
        onKeyDown={(e) => {
          if (e.target === e.currentTarget) enterStarts(e);
        }}
      >
        {draft.inputs.length === 0 ? (
          <span className="muted">Drop files or paste here</span>
        ) : (
          <ul className="chips" aria-label="Added sources">
            {draft.inputs.map((i) => (
              <li
                key={i.id}
                className="chip"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.target === e.currentTarget && (e.key === 'Backspace' || e.key === 'Delete')) {
                    e.preventDefault();
                    removeInput(i);
                    dropBox.current?.focus();
                  }
                }}
              >
                <span className="chip-icon" aria-hidden="true">
                  {chipIcon(i)}
                </span>
                <span className="chip-label">{chipLabel(i)}</span>
                <button
                  type="button"
                  className="chip-remove"
                  aria-label={`Remove ${chipLabel(i)}`}
                  onClick={() => removeInput(i)}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
        {dragging && (
          <div className="drop-overlay" aria-hidden="true">
            Drop to add
          </div>
        )}
      </div>
      {hint && (
        <p className="inline-hint" role="note">
          {hint.text}
          {hint.settingsLink && (
            <>
              {' '}
              <button type="button" className="link" onClick={p.onOpenSettings}>
                Open Settings
              </button>
            </>
          )}
        </p>
      )}
      <label className="field">
        <span className="field-label">URL</span>
        <input
          ref={urlField}
          type="text"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          placeholder="https://…"
          aria-label="URL"
          aria-invalid={urlError ? true : undefined}
          aria-describedby={urlError ? 'url-error' : undefined}
          value={draft.urlText}
          onChange={(e) => {
            const v = e.target.value;
            setDraft((d) => ({ ...d, urlText: v }));
            setUrlError(null);
          }}
          onPaste={onUrlPaste}
          onKeyDown={enterStarts}
        />
      </label>
      {urlError && (
        <p id="url-error" className="inline-error">
          {urlError}
        </p>
      )}
      <label className="field">
        <span className="field-label">Specifics</span>
        <textarea
          rows={clarifyRows(draft.clarifying)}
          aria-label="Specifics"
          placeholder="Optional: what do you want to understand? What do you already know?"
          value={draft.clarifying}
          onChange={(e) => {
            const v = e.target.value;
            setDraft((d) => ({ ...d, clarifying: v }));
          }}
          onKeyDown={enterStarts}
        />
      </label>
      <div className="input-actions">
        <label className="toggle">
          <input
            type="checkbox"
            role="switch"
            checked={draft.glossary}
            onChange={(e) => {
              const v = e.target.checked;
              setGlossaryTouched(true);
              setDraft((d) => ({ ...d, glossary: v }));
            }}
            onKeyDown={enterStarts}
          />
          Explain domain specific terms
        </label>
        <div className="input-buttons">
          <button
            type="button"
            className="clear-draft"
            disabled={!draftHasContent(draft)}
            onClick={() => {
              clearDraft();
              dropBox.current?.focus();
            }}
          >
            Clear
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => void start()}
            aria-busy={starting}
            title={mode === 'restart' ? RESTART_TOOLTIP : undefined}
          >
            {mode === 'restart' ? 'Restart' : 'Start'} <span aria-hidden="true">⏎</span>
          </button>
        </div>
      </div>
      {startError && (
        <p className="inline-error start-error" role="note">
          {startError.text}
          {startError.settingsLink && (
            <>
              {' '}
              <button type="button" className="link" onClick={p.onOpenSettings}>
                Open Settings
              </button>
            </>
          )}
        </p>
      )}
    </form>
  );
}
