// Document module errors (07 §8).

/** `parseDocument` failures: the document stays viewable but is not editable (07 §8, §15). */
export class DocumentFormatError extends Error {
  constructor(
    readonly code: 'no_model' | 'bad_version' | 'invalid_model',
    detail?: string,
  ) {
    super(detail ? `Document format error (${code}): ${detail}` : `Document format error (${code})`);
    this.name = 'DocumentFormatError';
  }
}

/**
 * Build and mutation failures (07 §5.1, §8). 'empty_section' is raised by replaceSection when the
 * regenerated draft has no valid blocks left (not named in 07 §8; see the module notes).
 */
export class DocumentBuildError extends Error {
  constructor(readonly code: 'empty_indepth' | 'empty_tab' | 'invalid_merge' | 'empty_section') {
    super(`Document build error (${code})`);
    this.name = 'DocumentBuildError';
  }
}

/** addSectionEli5Tab past the 20 section ELI5 tab limit (07 §5.4). */
export class TooManyTabsError extends Error {
  constructor(readonly limit: number) {
    super(`A document can have at most ${limit} section ELI5 tabs`);
    this.name = 'TooManyTabsError';
  }
}

/**
 * Mutator precondition failures (07 §8): unknown section or tab, the references section, or a tab
 * that cannot be removed. 08 maps these to E_NOT_FOUND / E_FORBIDDEN / SECTION_GONE.
 */
export class DocumentMutationError extends Error {
  constructor(
    readonly code: 'unknown_section' | 'unknown_tab' | 'references_section' | 'tab_not_removable',
    readonly target: string,
  ) {
    super(`Document mutation refused (${code}): ${target}`);
    this.name = 'DocumentMutationError';
  }
}

/** renderDocument without an injected runtime when build/doc-runtime/ was not built (01 §8.1). */
export class DocRuntimeMissingError extends Error {
  constructor() {
    super('The document runtime is not built: run "npm run build:runtime" first');
    this.name = 'DocRuntimeMissingError';
  }
}
