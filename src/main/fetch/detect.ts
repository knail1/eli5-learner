import { DETECT } from './constants';
import type { PageSignals } from './types';

/** Empty / client-rendered scoring (05 §6.2). */
export type Verdict = 'ok' | 'client-rendered' | 'empty';

/** Rules R1–R9, evaluated in order; the first match wins. */
export function classify(s: PageSignals): Verdict {
  if (s.articleTextLength >= DETECT.R1_ARTICLE_OK) return 'ok'; // R1
  if (s.articleTextLength >= DETECT.R2_ARTICLE_READERABLE && s.readerable) return 'ok'; // R2
  if (s.mountPointEmpty) return 'client-rendered'; // R3
  if (s.noscriptSaysEnableJs && s.bodyTextLength < DETECT.R4_BODY_TEXT) return 'client-rendered'; // R4
  if (
    s.scriptBytes / Math.max(s.bodyTextLength, 1) > DETECT.R5_SCRIPT_RATIO &&
    s.bodyTextLength < DETECT.R5_BODY_TEXT
  ) {
    return 'client-rendered'; // R5
  }
  if (s.challengeMarkers) return 'client-rendered'; // R6
  if (s.articleTextLength < DETECT.R7_ARTICLE && s.bodyTextLength < DETECT.R7_BODY) return 'empty'; // R7
  if (s.articleTextLength >= DETECT.R8_ARTICLE) return 'ok'; // R8
  return 'empty'; // R9
}

/** 05 §6.3 title markers; also used by the worker. */
export const CHALLENGE_TITLE = /just a moment|checking your browser|attention required|verify you are human/i;
