import { describe, expect, it } from 'vitest';
import { TurnGate } from '../src/main/interview/TurnGate';

describe('TurnGate', () => {
  it('waits on partial speech and answers only at end of turn', () => {
    const gate = new TurnGate();
    expect(gate.update('Tell me about your', 'partial').decision).toBe('WAIT');
    expect(gate.update('Tell me about your React experience?', 'end')).toEqual({ decision: 'ANSWER_NOW', transcript: 'Tell me about your React experience?' });
  });
  it('ignores empty completed turns', () => expect(new TurnGate().update('', 'end').decision).toBe('IGNORE'));
});
