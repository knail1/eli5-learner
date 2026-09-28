import type { LLMErrorKind } from './types';

const RETRYABLE: readonly LLMErrorKind[] = ['rate_limited', 'overloaded', 'server', 'timeout', 'network'];

/** Single error type for every LLM failure (02 §3.1). Messages never contain keys or source text. */
export class LLMError extends Error {
  constructor(
    public kind: LLMErrorKind,
    message: string,
    public status?: number,
    public retryAfterMs?: number,
    public override cause?: unknown,
  ) {
    super(message);
    this.name = 'LLMError';
  }

  get retryable(): boolean {
    return RETRYABLE.includes(this.kind);
  }
}
