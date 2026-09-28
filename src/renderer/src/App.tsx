import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { EditionInfo, Settings } from '../../preload/contract';

/**
 * M0 shell: layout regions from 11 §5 with placeholders, plus the AI settings needed to verify
 * config, Keychain and edition wiring. The full UI is M1b/M3.
 */
export function App() {
  const [edition, setEdition] = useState<EditionInfo | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [status, setStatus] = useState('');
  const keyInput = useRef<HTMLInputElement>(null);

  const provider = settings?.llm.provider === 'openai' ? 'openai' : 'claude';

  useEffect(() => {
    void window.eli5.edition.info().then((r) => r.ok && setEdition(r.value));
    void window.eli5.settings.get().then((r) => r.ok && setSettings(r.value));
    return window.eli5.settings.onChanged((e) => setSettings(e.settings));
  }, []);

  useEffect(() => {
    if (!settings) return;
    void window.eli5.settings.hasApiKey(provider).then((r) => setHasKey(r.ok ? r.value : null));
  }, [settings, provider]);

  const saveKey = async (e: FormEvent) => {
    e.preventDefault();
    const key = keyInput.current?.value ?? '';
    const r = await window.eli5.settings.setApiKey(provider, key);
    if (keyInput.current) keyInput.current.value = '';
    if (r.ok) {
      setStatus(r.warnings?.[0] ?? 'Key saved');
      setHasKey(true);
    } else {
      setStatus(r.error.message);
    }
  };

  const setProvider = async (p: 'claude' | 'openai') => {
    const r = await window.eli5.settings.set({ llm: { provider: p, model: null } });
    if (!r.ok) setStatus(r.error.message);
  };

  return (
    <div className="shell">
      <aside className="sidebar" aria-label="Library">
        <h2>Library</h2>
        <p className="muted">No documents yet.</p>
      </aside>
      <main className="main">
        <section className="viewer-slot" aria-label="Document viewer">
          <h1>ELI5 Learner</h1>
          <p className="muted">
            {edition ? `${edition.overlayName ?? 'Public'} edition` : 'Loading…'} · foundations build (M0)
          </p>
          <div className="card">
            <h3>AI provider</h3>
            <div className="row">
              {(['claude', 'openai'] as const).map((p) => (
                <label key={p}>
                  <input type="radio" name="provider" checked={provider === p} onChange={() => void setProvider(p)} />
                  {p === 'claude' ? 'Claude' : 'OpenAI'}
                </label>
              ))}
            </div>
            <form onSubmit={(e) => void saveKey(e)} className="row">
              <input
                ref={keyInput}
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder="API key"
                aria-label="API key"
              />
              <button type="submit">Save key</button>
            </form>
            <p className="muted">{hasKey === null ? '' : hasKey ? 'Key saved' : 'No key'}</p>
          </div>
        </section>
        <section className="input-zone" aria-label="Input">
          <p className="muted">Drop files, paste, or enter a URL (coming in M1).</p>
        </section>
      </main>
      <footer className="status" role="status">
        {status}
      </footer>
    </div>
  );
}
