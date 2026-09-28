/** Viewer-area empty and error states (11 §8). None of them is a modal or blocks the input zone. */

export function Welcome(p: { hasKey: boolean | null; libraryEmpty: boolean; onAddKey(): void }) {
  if (p.hasKey === false) {
    return (
      <section className="welcome" aria-labelledby="welcome-title">
        <h1 id="welcome-title">Turn anything into an explainer.</h1>
        <ol className="steps">
          <li>
            <button type="button" className="link" onClick={p.onAddKey}>
              Add an API key
            </button>{' '}
            in Settings.
          </li>
          <li>Drop a file, paste a screenshot, or enter a URL below.</li>
          <li>Press Enter.</li>
        </ol>
      </section>
    );
  }
  return (
    <section className="welcome" aria-labelledby="welcome-title">
      <h1 id="welcome-title">
        {p.libraryEmpty ? 'Turn anything into an explainer.' : 'Pick a document or start a new one.'}
      </h1>
      <p className="muted">
        Drop files, paste a screenshot, or enter a URL below, then press Enter
        <span className="down-arrow" aria-hidden="true">
          {' '}
          ↓
        </span>
      </p>
    </section>
  );
}

export function NotFound() {
  return (
    <section className="welcome" aria-labelledby="nf-title">
      <h1 id="nf-title">This document&rsquo;s files are missing.</h1>
      <p className="muted">It may have been merged into another document or removed from the Library folder.</p>
    </section>
  );
}

/**
 * Viewer load failure (11 §8). Replaces the slot, so the native viewer is detached while it shows;
 * Retry opens the document again.
 */
export function ViewerFailed(p: { onRetry(): void }) {
  return (
    <section className="welcome" aria-labelledby="vf-title">
      <h1 id="vf-title">Could not display this document.</h1>
      <button type="button" onClick={p.onRetry}>
        Retry
      </button>
    </section>
  );
}
