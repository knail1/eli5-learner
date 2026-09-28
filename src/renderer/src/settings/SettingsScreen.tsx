import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type {
  ApiKeyProvider,
  AuthStatus,
  DeepPartial,
  LibraryInfo,
  ProviderId,
  Settings,
  SettingsSection,
} from '../../../preload/contract';
import { FeatureGate, editionName, useEdition } from '../edition/FeatureGate';

/**
 * In-window settings route (11 §7). Non-secret settings save on change (debounced 300 ms) with a
 * quiet "Saved"; the API key goes only to the Keychain and is never shown back.
 */

const PROVIDER_LABEL: Record<string, string> = { claude: 'Claude', openai: 'OpenAI', bedrock: 'Bedrock' };
const SAVE_DEBOUNCE_MS = 300;

type SaveState = Record<string, { saved: boolean; error?: string }>;

function useSettingSaver() {
  const [state, setState] = useState<SaveState>({});
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const t = timers.current;
    return () => t.forEach(clearTimeout);
  }, []);
  const save = useCallback((key: string, patch: DeepPartial<Settings>) => {
    clearTimeout(timers.current.get(key));
    setState((s) => ({ ...s, [key]: { saved: false } }));
    timers.current.set(
      key,
      setTimeout(() => {
        void window.eli5.settings.set(patch).then((r) => {
          setState((s) => ({ ...s, [key]: r.ok ? { saved: true } : { saved: false, error: r.error.message } }));
        });
      }, SAVE_DEBOUNCE_MS),
    );
  }, []);
  return { state, save };
}

function SaveNote(p: { s: { saved: boolean; error?: string } | undefined }) {
  if (p.s?.error) return <span className="inline-error">{p.s.error}</span>;
  return p.s?.saved ? <span className="saved">Saved</span> : null;
}

export function SettingsScreen(p: { settings: Settings | null; section?: SettingsSection; onKeyChanged(): void }) {
  const edition = useEdition();
  const { state, save } = useSettingSaver();
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const target = p.section ? root.current?.querySelector<HTMLElement>(`#settings-${p.section}`) : root.current;
    target?.scrollIntoView?.({ block: 'start' });
    target?.querySelector<HTMLElement>('h2')?.focus();
  }, [p.section]);

  if (!p.settings) return <p className="muted settings">Loading settings…</p>;
  const s = p.settings;

  // Unavailable providers are not shown, so dormant bedrock never appears in the public build.
  const providers = (
    edition?.llmProviders ?? [
      { id: 'claude', available: true },
      { id: 'openai', available: true },
    ]
  )
    .filter((x) => x.available)
    .map((x) => x.id);

  return (
    <div className="settings" ref={root}>
      <h1>Settings</h1>

      <section id="settings-ai" aria-labelledby="h-ai">
        <h2 id="h-ai" tabIndex={-1}>
          AI provider
        </h2>
        <ProviderPicker
          providers={providers}
          value={s.llm.provider}
          onChange={(v) => save('llm.provider', { llm: { provider: v as ProviderId, model: null } })}
        />
        <SaveNote s={state['llm.provider']} />
        {(s.llm.provider === 'claude' || s.llm.provider === 'openai') && (
          <ApiKeyPanel provider={s.llm.provider} onChanged={p.onKeyChanged} />
        )}
        <ModelField
          provider={s.llm.provider}
          value={s.llm.model}
          onChange={(v) => save('llm.model', { llm: { model: v } })}
        />
        <SaveNote s={state['llm.model']} />
      </section>

      <section id="settings-documents" aria-labelledby="h-documents">
        <h2 id="h-documents" tabIndex={-1}>
          Documents
        </h2>
        <label className="toggle">
          <input
            type="checkbox"
            role="switch"
            checked={s.glossary.defaultOn}
            onChange={(e) => save('glossary.defaultOn', { glossary: { defaultOn: e.target.checked } })}
          />
          Explain domain specific terms by default
        </label>
        <SaveNote s={state['glossary.defaultOn']} />
      </section>

      <section id="settings-library" aria-labelledby="h-library">
        <h2 id="h-library" tabIndex={-1}>
          Library
        </h2>
        <LibraryInfoPanel />
      </section>

      <section id="settings-publishing" aria-labelledby="h-publishing">
        <h2 id="h-publishing" tabIndex={-1}>
          Publishing
        </h2>
        <p>
          <span className="field-label">Export folder</span> <code className="path">{s.publish.local.dir}</code>
        </p>
        <label className="toggle">
          <input
            type="checkbox"
            role="switch"
            checked={s.publish.local.revealAfter}
            onChange={(e) =>
              save('publish.local.revealAfter', { publish: { local: { revealAfter: e.target.checked } } })
            }
          />
          Reveal in Finder after export
        </label>
        <SaveNote s={state['publish.local.revealAfter']} />
      </section>

      <section id="settings-about" aria-labelledby="h-about">
        <h2 id="h-about" tabIndex={-1}>
          About
        </h2>
        <p>ELI5 Learner</p>
        <p className="muted">{editionName(edition)}</p>
      </section>

      <FeatureGate feature="auth.signIn">
        <section id="settings-enterprise" aria-labelledby="h-enterprise">
          <h2 id="h-enterprise" tabIndex={-1}>
            Enterprise
          </h2>
          <SignInIndicator />
        </section>
      </FeatureGate>
    </div>
  );
}

function ProviderPicker(p: { providers: string[]; value: string; onChange(v: string): void }) {
  // Optimistic until eli5:settings:changed confirms.
  const [value, setValue] = useState(p.value);
  useEffect(() => setValue(p.value), [p.value]);
  return (
    <div className="row" role="radiogroup" aria-label="AI provider">
      {p.providers.map((id) => (
        <label key={id}>
          <input
            type="radio"
            name="provider"
            checked={value === id}
            onChange={() => {
              setValue(id);
              p.onChange(id);
            }}
          />
          {PROVIDER_LABEL[id] ?? id}
        </label>
      ))}
    </div>
  );
}

function ApiKeyPanel(p: { provider: ApiKeyProvider; onChanged(): void }) {
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let live = true;
    setMessage(null);
    void window.eli5.settings.hasApiKey(p.provider).then((r) => {
      if (live) setHasKey(r.ok ? r.value : null);
    });
    return () => {
      live = false;
    };
  }, [p.provider]);

  const saveKey = async (e: FormEvent) => {
    e.preventDefault();
    const key = input.current?.value ?? '';
    if (!key.trim()) return;
    const r = await window.eli5.settings.setApiKey(p.provider, key);
    // Never keep the key in the DOM after saving (11 §7).
    if (input.current) input.current.value = '';
    if (r.ok) {
      setHasKey(true);
      setMessage(r.warnings?.[0] ?? null);
      p.onChanged();
    } else {
      setMessage(r.error.message);
    }
  };

  const remove = async () => {
    const r = await window.eli5.settings.clearApiKey(p.provider);
    if (r.ok) {
      setHasKey(false);
      setMessage(null);
      p.onChanged();
    } else setMessage(r.error.message);
  };

  const test = async () => {
    setTesting(true);
    setMessage(null);
    const r = await window.eli5.llm.testConnection(p.provider);
    setTesting(false);
    if (!r.ok) setMessage(r.error.message);
    else if (r.value.ok) setMessage(`Connected (${r.value.model ?? 'default model'})`);
    else setMessage(r.value.message ?? 'Could not connect');
  };

  return (
    <div className="api-key">
      <form className="row" onSubmit={(e) => void saveKey(e)}>
        <input
          ref={input}
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={`${p.provider === 'claude' ? 'Claude' : 'OpenAI'} API key`}
          aria-label="API key"
        />
        <button type="submit">Save key</button>
      </form>
      <div className="row">
        <span className="muted" data-testid="key-state">
          {hasKey === null ? '' : hasKey ? 'Key saved in Keychain' : 'No key'}
        </span>
        {hasKey && (
          <button type="button" onClick={() => void remove()}>
            Remove
          </button>
        )}
        <button type="button" onClick={() => void test()} disabled={testing} aria-busy={testing}>
          {testing ? 'Testing…' : 'Test connection'}
        </button>
      </div>
      {message && <p className="note">{message}</p>}
    </div>
  );
}

function ModelField(p: { provider: ProviderId; value: string | null; onChange(v: string | null): void }) {
  const [text, setText] = useState(p.value ?? '');
  const [suggested, setSuggested] = useState<string[]>([]);
  const [placeholder, setPlaceholder] = useState('');
  useEffect(() => setText(p.value ?? ''), [p.value]);
  useEffect(() => {
    let live = true;
    void window.eli5.llm.models(p.provider).then((r) => {
      if (!live || !r.ok) return;
      setSuggested(r.value.suggested);
      setPlaceholder(r.value.default ? `Default (${r.value.default})` : 'Default');
    });
    return () => {
      live = false;
    };
  }, [p.provider]);
  return (
    <label className="field">
      <span className="field-label">Model</span>
      <input
        type="text"
        aria-label="Model"
        list="model-suggestions"
        placeholder={placeholder}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          p.onChange(e.target.value.trim() || null);
        }}
      />
      <datalist id="model-suggestions">
        {suggested.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
    </label>
  );
}

function LibraryInfoPanel() {
  const [info, setInfo] = useState<LibraryInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void window.eli5.library.info().then((r) => {
      if (r.ok) setInfo(r.value);
      else setError(r.error.message);
    });
  }, []);
  if (error) return <p className="muted">Library details are not available: {error}</p>;
  if (!info) return null;
  return (
    <>
      <p>
        <span className="field-label">Location</span> <code className="path">{info.root}</code>
      </p>
      <p>
        {info.count} {info.count === 1 ? 'document' : 'documents'}
      </p>
      {info.readOnly && (
        <p className="inline-error">Read only{info.readOnlyReason ? `: ${info.readOnlyReason}` : ''}</p>
      )}
    </>
  );
}

/** Generic sign-in indicator, mounted only when HOOK-UI-01 enables auth.signIn. */
export function SignInIndicator() {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  useEffect(() => {
    void window.eli5.auth.status().then((r) => r.ok && setStatus(r.value));
    return window.eli5.auth.onChanged(setStatus);
  }, []);
  const label =
    status?.state === 'signed-in' ? 'Signed in' : status?.state === 'expired' ? 'Session expired · Sign in' : 'Sign in';
  const signedIn = status?.state === 'signed-in';
  return (
    <button
      type="button"
      className="sign-in"
      disabled={signedIn}
      onClick={() => void window.eli5.auth.signIn().then((r) => r.ok && setStatus(r.value))}
    >
      {label}
    </button>
  );
}
