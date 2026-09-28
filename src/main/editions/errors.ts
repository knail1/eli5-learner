import type { Edition } from './types';

/** Thrown by every stub. Mapped to E_NOT_AVAILABLE_IN_EDITION at the IPC boundary (01 §6.4). */
export class NotAvailableInEdition extends Error {
  readonly code = 'E_NOT_AVAILABLE_IN_EDITION' as const;
  constructor(
    readonly capability: string,
    readonly hookId: string,
    readonly edition: Edition,
  ) {
    super(`${capability} is not available in the ${edition} edition.`);
    this.name = 'NotAvailableInEdition';
  }
}
