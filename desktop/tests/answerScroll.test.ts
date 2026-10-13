import { describe, expect, it } from 'vitest';
import { qaFontResizeDelta, readingLineTopOffset, renderedAnswerLineHeight } from '../src/renderer/services/answerScroll';

describe('answer keyboard scrolling', () => {
  it('uses the currently rendered line height', () => {
    expect(renderedAnswerLineHeight({ lineHeight: '19.5px', fontSize: '13px' })).toBe(19.5);
  });

  it('falls back to the rendered font size when line-height is normal', () => {
    expect(renderedAnswerLineHeight({ lineHeight: 'normal', fontSize: '14px' })).toBe(21);
  });

  it('bounds abnormal measurements to a useful single-line step', () => {
    expect(renderedAnswerLineHeight({ lineHeight: '4px', fontSize: '2px' })).toBe(12);
    expect(renderedAnswerLineHeight({ lineHeight: '200px', fontSize: '100px' })).toBe(64);
  });

  it('keeps the spoken line close to the container top at every rendered line size', () => {
    expect(readingLineTopOffset(12)).toBe(2);
    expect(readingLineTopOffset(20)).toBe(2);
    expect(readingLineTopOffset(64)).toBe(3);
  });

  it('grows and shrinks both live workspace dimensions one font point at a time', () => {
    expect(qaFontResizeDelta(13, 14)).toEqual({ width: 20, height: 12 });
    expect(qaFontResizeDelta(14, 13)).toEqual({ width: -20, height: -12 });
  });
});
