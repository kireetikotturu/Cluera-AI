import { describe, expect, it } from 'vitest';
import type { TranscriptEvent } from '../src/shared/types';
import { TranscriptOwnership } from '../src/renderer/services/transcriptOwnership';

const event = (role: TranscriptEvent['sourceRole'], text: string, confidence = .9): TranscriptEvent => ({
  text,
  isFinal: false,
  sourceId: role === 'remote_interviewer' ? 'system' : 'candidate',
  sourceKind: role === 'remote_interviewer' ? 'system' : 'microphone',
  sourceRole: role,
  canTriggerAnswers: role === 'remote_interviewer',
  confidence,
  timestamp: 1,
});

describe('shared transcript speaker ownership', () => {
  it('keeps interviewer ownership while candidate noise arrives during the grace period', () => {
    let now = 1_000;
    const owner = new TranscriptOwnership(1_500, () => now);
    expect(owner.shouldClaim(event('remote_interviewer', 'Explain dependency injection'))).toBe(true);
    now += 700;
    expect(owner.shouldClaim(event('local_candidate', 'background microphone noise'))).toBe(false);
  });

  it('exposes the remaining delay so a valid short reply is not lost during grace', () => {
    let now = 1_000;
    const owner = new TranscriptOwnership(1_500, () => now);
    owner.shouldClaim(event('remote_interviewer', 'Tell me about your project'));
    now += 700;
    const reply = event('local_candidate', 'I built the API with TypeScript');
    expect(owner.shouldClaim(reply)).toBe(false);
    expect(owner.candidateClaimDelay(reply)).toBe(800);
    now += 800;
    expect(owner.shouldClaim(reply)).toBe(true);
  });

  it('does not schedule weak microphone noise and resets between sessions', () => {
    let now = 1_000;
    const owner = new TranscriptOwnership(1_500, () => now);
    owner.shouldClaim(event('remote_interviewer', 'Question'));
    expect(owner.candidateClaimDelay(event('local_candidate', 'uh', .2))).toBeNull();
    owner.reset();
    expect(owner.shouldClaim(event('local_candidate', 'My new session response'))).toBe(true);
  });

  it('allows clear candidate speech after the interviewer grace period', () => {
    let now = 1_000;
    const owner = new TranscriptOwnership(1_500, () => now);
    owner.shouldClaim(event('remote_interviewer', 'Tell me about your project'));
    now += 1_501;
    expect(owner.shouldClaim(event('local_candidate', 'I built the service with TypeScript'))).toBe(true);
  });

  it('immediately returns ownership to the interviewer and rejects weak mic noise', () => {
    let now = 4_000;
    const owner = new TranscriptOwnership(1_500, () => now);
    expect(owner.shouldClaim(event('local_candidate', 'uh', .2))).toBe(false);
    expect(owner.shouldClaim(event('local_candidate', 'I am ready now'))).toBe(true);
    now += 10;
    expect(owner.shouldClaim(event('remote_interviewer', 'Great, next question'))).toBe(true);
  });
});
