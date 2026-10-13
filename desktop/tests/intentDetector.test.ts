import { describe, expect, it } from 'vitest';
import { IntentDetector } from '../src/main/interview/IntentDetector';

describe('IntentDetector', () => {
  const detector = new IntentDetector();
  it('ignores small talk', () => expect(detector.detect('Okay, great.').isAnswerNeeded).toBe(false));
  it('waits for an incomplete question', () => expect(detector.detect('Tell me about your experience with').isComplete).toBe(false));
  it('classifies technical questions', () => expect(detector.detect('How have you used React in production?').intent).toBe('TECHNICAL_QUESTION'));
  it('classifies behavioral questions', () => expect(detector.detect('Tell me about a time when you handled a difficult conflict.').intent).toBe('BEHAVIORAL_QUESTION'));
  it('detects multiple questions', () => expect(detector.detect('What did you build? And also how did you test it?').intent).toBe('MULTI_PART_QUESTION'));
  it('waits for an ellipsis-ended incomplete question', () => expect(detector.detect('Tell me about your experience with…').isComplete).toBe(false));
  it('extracts the real question after context', () => expect(detector.detect('MongoDB is important for us. Have you used MongoDB?').question).toBe('Have you used MongoDB?'));
  it('classifies coding and system-design questions', () => {
    expect(detector.detect('Implement a function and explain its complexity?').intent).toBe('CODING_QUESTION');
    expect(detector.detect('How would you design a highly available distributed system?').intent).toBe('SYSTEM_DESIGN');
  });
  it('recognizes follow-ups and multi-part questions', () => {
    expect(detector.detect('And why did you choose that approach?').intent).toBe('FOLLOW_UP');
    expect(detector.detect('Can you explain authentication and how you secured the API?').intent).toBe('MULTI_PART_QUESTION');
  });
});
