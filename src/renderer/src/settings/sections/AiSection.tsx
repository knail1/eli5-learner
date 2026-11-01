import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ApiKeyProvider, ProviderId } from '../../../../preload/contract';
import { useEdition } from '../../edition/FeatureGate';
import { LockedNote, SaveNote, SettingsSectionFrame, type SectionProps } from '../save';

/**
 * Settings > AI provider, API key, model (11 §7). Managed keys are read-only (HOOK-CFG-01); the key
 * field never shows a stored key (12 §5.2).
 */

/** 12 §13 E_KEYCHAIN_UNAVAILABLE text. */
const KEYCHAIN_TEXT = 'Keychain access denied. Unlock or allow access, then retry';

/** Claude is the default (12 §3.2); ChatGPT runs on the OpenAI API with an OpenAI platform key (02 §6). */
const PROVIDER_LABEL: Record<string, string> = { claude: 'Claude', openai: 'ChatGPT (OpenAI)', bedrock: 'Bedrock' };

export function AiSection(p: SectionProps & { onKeyChanged(): void; keychainAvailable?: boolean }) {
  const edition = useEdition();
  const { state, save } = p.saver;
  const s = p.settings;
  const providerLocked = p.isLocked('llm.provider');
  const modelLocked = p.isLocked('llm.model');
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
        disabled={providerLocked}
        // 12 §3.2: a provider change resets the model unless that key is managed.
        onChange={(v) =>
          save('llm.provider', {
            llm: modelLocked ? { provider: v as ProviderId } : { provider: v as ProviderId, model: null },
          })
        }
      />
      <LockedNote locked={providerLocked} />
      <SaveNote s={state['llm.provider']} />
      {p.keychainAvailable === false && <p className="inline-error">{KEYCHAIN_TEXT}</p>}
      {(s.llm.provider === 'claude' || s.llm.provider === 'openai') && (
        <ApiKeyPanel provider={s.llm.provider} onChanged={p.onKeyChanged} />
      )}
      <ModelField
        provider={s.llm.provider}
        value={s.llm.model}
        readOnly={modelLocked}
        onChange={(v, immediate) => save('llm.model', { llm: { model: v } }, { immediate })}
      />
      <LockedNote locked={modelLocked} />
      <SaveNote s={state['llm.model']} />
    </SettingsSectionFrame>
  );
}

function ProviderPicker(p: { providers: string[]; value: string; disabled: boolean; onChange(v: string): void }) {
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
            disabled={p.disabled}
            onChange={() => {
              if (p.disabled) return;
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

  // 11 §7: the key, its state row and the Model field share one label column, so every input
  // starts at the same x.
  return (
    <div className="api-key">
      <form className="field" onSubmit={(e) => void saveKey(e)}>
        <span className="field-label" aria-hidden="true">
          API key
        </span>
        <div className="field-row">
          <input
            ref={input}
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={`${p.provider === 'claude' ? 'Claude' : 'OpenAI'} API key`}
            aria-label="API key"
          />
          <button type="submit">Save key</button>
        </div>
      </form>
      <div className="field">
        <span />
        <div className="field-row">
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
      </div>
      {message && <p className="note">{message}</p>}
    </div>
  );
}

const CUSTOM = '__custom__';

/**
 * Model picker (11 §7): a dropdown of the provider's suggested models, then "Custom…", which
 * reveals a "Custom model ID" field. A listed pick saves at once; typing saves with a delay.
 */
function ModelField(p: {
  provider: ProviderId;
  value: string | null;
  readOnly: boolean;
  onChange(v: string | null, immediate: boolean): void;
}) {
  const [suggested, setSuggested] = useState<string[]>([]);
  const [fallback, setFallback] = useState('');
  // The user chose Custom; it stays chosen while the typed id is empty or equals a listed one.
  const [customChosen, setCustomChosen] = useState(false);
  const [text, setText] = useState(p.value ?? '');
  // While the field has focus, echoes of earlier debounced saves must not overwrite newer typing;
  // external values (such as a provider switch) apply whenever it is not focused.
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) setText(p.value ?? '');
  }, [p.value]);
  useEffect(() => {
    let live = true;
    // Switching provider reloads the list and leaves Custom.
    setCustomChosen(false);
    void window.eli5.llm.models(p.provider).then((r) => {
      if (!live || !r.ok) return;
      setSuggested(r.value.suggested);
      setFallback(r.value.default);
    });
    return () => {
      live = false;
    };
  }, [p.provider]);

  // The saved model if listed; the provider default if nothing is saved; Custom when the saved id
  // is not in a non-empty list (or there is no list at all) or the user chose Custom.
  const listed = p.value !== null && suggested.includes(p.value);
  const custom = customChosen || suggested.length === 0 || (p.value !== null && !listed);
  const selected = custom ? CUSTOM : (p.value ?? fallback);

  return (
    <>
      <label className="field">
        <span className="field-label">Model</span>
        <select
          aria-label="Model"
          value={selected}
          disabled={p.readOnly}
          onChange={(e) => {
            if (p.readOnly) return;
            const v = e.target.value;
            if (v === CUSTOM) {
              setCustomChosen(true);
              setText(p.value ?? '');
              return;
            }
            setCustomChosen(false);
            p.onChange(v, true);
          }}
        >
          {suggested.map((m) => (
            <option key={m} value={m}>
              {m === fallback ? `${m} (default)` : m}
            </option>
          ))}
          {/* The provider default before the list arrives, so the select never shows a blank value. */}
          {fallback && !suggested.includes(fallback) && !custom && <option value={fallback}>{fallback}</option>}
          <option value={CUSTOM}>Custom…</option>
        </select>
      </label>
      {custom && (
        <label className="field">
          <span className="field-label">Custom</span>
          <input
            type="text"
            aria-label="Custom model ID"
            spellCheck={false}
            autoComplete="off"
            placeholder={fallback}
            value={text}
            disabled={p.readOnly}
            onFocus={() => {
              editing.current = true;
            }}
            onBlur={() => {
              editing.current = false;
            }}
            onChange={(e) => {
              if (p.readOnly) return;
              setCustomChosen(true);
              setText(e.target.value);
              p.onChange(e.target.value.trim() || null, false);
            }}
          />
        </label>
      )}
    </>
  );
}
