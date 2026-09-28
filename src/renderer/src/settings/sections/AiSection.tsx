import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ApiKeyProvider, ProviderId } from '../../../../preload/contract';
import { useEdition } from '../../edition/FeatureGate';
import { SaveNote, SettingsSectionFrame, type SectionProps } from '../save';

/** Settings > AI provider, API key, model (11 §7). */

const PROVIDER_LABEL: Record<string, string> = { claude: 'Claude', openai: 'OpenAI', bedrock: 'Bedrock' };

export function AiSection(p: SectionProps & { onKeyChanged(): void }) {
  const edition = useEdition();
  const { state, save } = p.saver;
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
    <SettingsSectionFrame id="ai" title="AI provider">
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
    </SettingsSectionFrame>
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
  // While the user edits, echoes of earlier debounced saves (settings.changed) must not overwrite
  // newer typing; external values (e.g. a provider switch) apply whenever the field is not focused.
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) setText(p.value ?? '');
  }, [p.value]);
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
        onFocus={() => {
          editing.current = true;
        }}
        onBlur={() => {
          editing.current = false;
        }}
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
