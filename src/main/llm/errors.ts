import type { LLMErrorKind, TokenUsage } from './types';

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

  /**
   * Tokens the failed call (and its repair) already spent, when a response came back before the
   * failure (D25): an output overflow or a second validation failure. Absent for transport errors.
   */
  usage?: TokenUsage;

  get retryable(): boolean {
    return RETRYABLE.includes(this.kind);
  }
}
