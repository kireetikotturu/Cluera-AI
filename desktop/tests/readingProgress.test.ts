import { describe, expect, it } from 'vitest';
import { estimateReadingProgress } from '../src/renderer/services/readingProgress';

describe('candidate answer reading progress', () => {
  const answer = 'I would start by clarifying the requirements. Then I would design a small reliable API and test the edge cases.';

  it('tracks a sequential spoken prefix', () => {
    const progress = estimateReadingProgress(answer, 'I would start by clarifying the requirements then I would design');
    expect(progress.matchedWords).toBeGreaterThanOrEqual(10);
    expect(progress.ratio).toBeGreaterThan(0.45);
    expect(progress.ratio).toBeLessThan(0.8);
  });

  it('tolerates recognition errors and omitted words', () => {
    const progress = estimateReadingProgress(answer, 'I will start clarifying requirement then I would desine a reliable API');
    expect(progress.ratio).toBeGreaterThan(0.55);
  });

  it('does not jump for unrelated candidate speech', () => {
    expect(estimateReadingProgress(answer, 'Thanks that makes sense to me').ratio).toBe(0);
  });

  it('jumps forward when the candidate begins from a later strong sentence', () => {
    const longer = 'First I clarify the requirements and expected inputs. Next I identify the key constraints. Finally I validate the deployment with health checks and rollback monitoring.';
    const progress = estimateReadingProgress(longer, 'validate the deployment with health checks and rollback');
    expect(progress.confidence).toBeGreaterThan(.5);
    expect(progress.ratio).toBeGreaterThan(.7);
  });

  it('keeps accepted progress moving forward when a later transcript is imperfect', () => {
    const first = estimateReadingProgress(answer, 'Then I would design a small reliable API');
    const next = estimateReadingProgress(answer, 'random noisy words', first.currentWordIndex);
    expect(next.currentWordIndex).toBe(first.currentWordIndex);
  });
});
