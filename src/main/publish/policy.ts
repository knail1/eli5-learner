import type { PrePublishPolicy } from './types';

/** Public pre-publish policy: always allows (10 §9, HOOK-PUB-05). */
export const defaultPrePublishPolicy: PrePublishPolicy = () => Promise.resolve({ allow: true });
