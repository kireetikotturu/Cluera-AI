function pixels(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function renderedAnswerLineHeight(style: Pick<CSSStyleDeclaration, 'lineHeight' | 'fontSize'>): number {
  const explicitLineHeight = pixels(style.lineHeight);
  if (explicitLineHeight > 0) return Math.max(12, Math.min(64, explicitLineHeight));
  const fontSize = pixels(style.fontSize);
  return Math.max(12, Math.min(64, (fontSize || 12) * 1.5));
}

export function readingLineTopOffset(lineHeight: number): number {
  const safeLineHeight = Number.isFinite(lineHeight) && lineHeight > 0 ? lineHeight : 18;
  return Math.max(2, Math.min(3, safeLineHeight * .1));
}

/** Keep larger Q&A text readable by growing the live workspace from its fixed top-left anchor. */
export function qaFontResizeDelta(currentSize: number, nextSize: number): { width: number; height: number } {
  const applied = Math.round(nextSize) - Math.round(currentSize);
  return { width: applied * 20, height: applied * 12 };
}
