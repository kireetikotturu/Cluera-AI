import { describe, expect, it } from 'vitest';
import type { ConversationTurn } from '../src/shared/types';
import { buildTranscriptExchanges } from '../src/renderer/pages/HistoryPage';

const turn = (
  id: string,
  speaker: ConversationTurn['speaker'],
  text: string,
  questionId?: string,
): ConversationTurn => ({
  id,
  sessionId: '00000000-0000-4000-8000-000000000001',
  speaker,
  text,
  questionId,
  createdAt: `2026-09-16T10:0${id.length}:00.000Z`,
});

describe('history transcript exchanges', () => {
  it('pairs candidate speech with the preceding interviewer question', () => {
    const exchanges = buildTranscriptExchanges([
      turn('q1', 'interviewer', 'Tell me about your project.'),
      turn('a1', 'candidate', 'I built a deployment platform.'),
      turn('q2', 'interviewer', 'What was the main challenge?'),
    ]);
    expect(exchanges).toHaveLength(2);
    expect(exchanges[0].candidate.map((item) => item.text)).toEqual(['I built a deployment platform.']);
    expect(exchanges[1].candidate).toEqual([]);
  });

  it('uses question associations when overlapping speech is stored', () => {
    const exchanges = buildTranscriptExchanges([
      turn('q1', 'interviewer', 'First question', 'question-1'),
      turn('q2', 'interviewer', 'Second question', 'question-2'),
      turn('a1', 'candidate', 'Answer to the first question', 'question-1'),
    ]);
    expect(exchanges[0].candidate[0]?.text).toBe('Answer to the first question');
    expect(exchanges[1].candidate).toEqual([]);
  });
});
