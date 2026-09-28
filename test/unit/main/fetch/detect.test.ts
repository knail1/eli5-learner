import { describe, expect, it } from 'vitest';
import { classify } from '../../../../src/main/fetch/detect';
import type { PageSignals } from '../../../../src/main/fetch/types';

const base: PageSignals = {
  bodyTextLength: 3000,
  articleTextLength: 0,
  readerable: false,
  scriptBytes: 0,
  htmlBytes: 10_000,
  mountPointEmpty: false,
  noscriptSaysEnableJs: false,
  hasPasswordField: false,
  formCount: 0,
  metaRefreshUrl: null,
  titleText: 'Title',
  challengeMarkers: false,
};
const s = (o: Partial<PageSignals>): PageSignals => ({ ...base, ...o });

describe('classify R1–R9 (05 §6.2)', () => {
  it('R1: articleTextLength >= 1500 is ok even with a mount point', () => {
    expect(classify(s({ articleTextLength: 1500, mountPointEmpty: true }))).toBe('ok');
  });
  it('R2: >= 500 and readerable is ok', () => {
    expect(classify(s({ articleTextLength: 500, readerable: true, mountPointEmpty: true }))).toBe('ok');
  });
  it('R3: empty mount point is client-rendered', () => {
    expect(classify(s({ articleTextLength: 499, readerable: true, mountPointEmpty: true }))).toBe('client-rendered');
  });
  it('R4: noscript "enable javascript" with little body text', () => {
    expect(classify(s({ noscriptSaysEnableJs: true, bodyTextLength: 999 }))).toBe('client-rendered');
    expect(classify(s({ noscriptSaysEnableJs: true, bodyTextLength: 1000, articleTextLength: 300 }))).toBe('ok');
  });
  it('R5: script-heavy page with little text', () => {
    expect(classify(s({ scriptBytes: 40_000, bodyTextLength: 1_900 }))).toBe('client-rendered');
    expect(classify(s({ scriptBytes: 21, bodyTextLength: 0 }))).toBe('client-rendered');
    expect(classify(s({ scriptBytes: 20, bodyTextLength: 0 }))).toBe('empty');
    expect(classify(s({ scriptBytes: 40_000, bodyTextLength: 2_000, articleTextLength: 300 }))).toBe('ok');
  });
  it('R6: challenge markers', () => {
    expect(classify(s({ challengeMarkers: true, articleTextLength: 600 }))).toBe('client-rendered');
  });
  it('R7: little article and body text is empty', () => {
    expect(classify(s({ articleTextLength: 199, bodyTextLength: 499 }))).toBe('empty');
  });
  it('R8: a short but real page is ok', () => {
    expect(classify(s({ articleTextLength: 200, bodyTextLength: 400 }))).toBe('ok');
  });
  it('R9: otherwise empty', () => {
    expect(classify(s({ articleTextLength: 150, bodyTextLength: 800 }))).toBe('empty');
  });
});
