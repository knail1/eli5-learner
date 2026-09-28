import type { Edition } from '../../preload/contract';

export type { Edition };

/** Current build's edition (01 §6.1); a build-time constant, never a setting. */
export const edition: Edition = __ELI5_EDITION__;
