// Light interactivity for components (07 §7.1): chart tooltips, stepper, figure markers, print.

/** Hover/focus tooltips on chart marks (07 §7.2); data lives in data-label / data-value. */
export function initCharts(doc: Document): void {
  if (!doc.querySelector('figure.chart')) return;
  const tip = doc.createElement('div');
  tip.className = 'viz-tip';
  tip.setAttribute('role', 'status');
  tip.setAttribute('data-eli5-noact', '');
  tip.hidden = true;
  doc.body.appendChild(tip);
  const show = (e: Event): void => {
    const mark = (e.target as Element | null)?.closest?.('figure.chart [data-value]');
    if (!mark) return;
    tip.textContent = `${mark.getAttribute('data-label') ?? ''}: ${mark.getAttribute('data-value') ?? ''}`;
    const r = mark.getBoundingClientRect();
    const win = doc.defaultView;
    tip.style.left = `${Math.round(r.left + r.width / 2 + (win?.scrollX ?? 0))}px`;
    tip.style.top = `${Math.round(r.top + (win?.scrollY ?? 0) - 6)}px`;
    tip.hidden = false;
  };
  const hide = (e: Event): void => {
    if ((e.target as Element | null)?.closest?.('figure.chart [data-value]')) tip.hidden = true;
  };
  doc.addEventListener('mouseover', show);
  doc.addEventListener('focusin', show);
  doc.addEventListener('mouseout', hide);
  doc.addEventListener('focusout', hide);
}

/** Stepper: prev/next and dots; without JS and in print all steps are visible (07 §7.1, §13). */
export function initSteppers(doc: Document): void {
  for (const stepper of Array.from(doc.querySelectorAll<HTMLElement>('.stepper'))) {
    const steps = Array.from(stepper.querySelectorAll<HTMLElement>('.step'));
    if (steps.length < 2) continue;
    let i = 0;
    const nav = doc.createElement('div');
    nav.className = 'stepper-nav';
    const prev = doc.createElement('button');
    prev.type = 'button';
    prev.textContent = 'Previous';
    const next = doc.createElement('button');
    next.type = 'button';
    next.textContent = 'Next';
    const dots = doc.createElement('div');
    dots.className = 'stepper-dots';
    dots.setAttribute('aria-hidden', 'true');
    const status = doc.createElement('span');
    status.setAttribute('aria-live', 'polite');
    const dotEls = steps.map(() => dots.appendChild(doc.createElement('span')));
    nav.append(prev, dots, next, status);
    stepper.appendChild(nav);
    stepper.classList.add('stepper--js');
    const show = (n: number): void => {
      i = Math.max(0, Math.min(steps.length - 1, n));
      steps.forEach((s, k) => s.classList.toggle('is-current', k === i));
      dotEls.forEach((d, k) => d.classList.toggle('is-current', k === i));
      prev.disabled = i === 0;
      next.disabled = i === steps.length - 1;
      status.textContent = `Step ${i + 1} of ${steps.length}`;
    };
    prev.addEventListener('click', () => show(i - 1));
    next.addEventListener('click', () => show(i + 1));
    show(0);
  }
}

/** Annotated figures: a marker click/focus highlights its note (07 §7.1). */
export function initFigures(doc: Document): void {
  const activate = (e: Event): void => {
    const m = (e.target as Element | null)?.closest?.('a.fig-marker');
    if (!m) return;
    const fig = m.closest('figure');
    const id = (m.getAttribute('href') ?? '').slice(1);
    for (const li of Array.from(fig?.querySelectorAll('.fig-notes li') ?? []))
      li.classList.toggle('is-active', li.id === id);
    if (e.type === 'click') e.preventDefault();
  };
  doc.addEventListener('click', activate);
  doc.addEventListener('focusin', activate);
}

/** Print (07 §13): open every glossary note before printing and restore afterwards. */
export function initPrint(win: Window, doc: Document): void {
  let closed: HTMLDetailsElement[] = [];
  win.addEventListener('beforeprint', () => {
    closed = Array.from(doc.querySelectorAll<HTMLDetailsElement>('details.gl-note:not([open])'));
    for (const d of closed) d.open = true;
  });
  win.addEventListener('afterprint', () => {
    for (const d of closed) d.open = false;
    closed = [];
  });
}
