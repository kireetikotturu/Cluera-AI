import { beforeEach, describe, expect, it } from 'vitest';
import { afterWords, isNewSpeech, latestWords } from '../src/renderer/services/liveTalk';
import { INTERVIEWER_OWNERSHIP_GRACE_MS, TranscriptOwnership } from '../src/renderer/services/transcriptOwnership';
import { useAppStore } from '../src/renderer/stores/appStore';
import type { TranscriptEvent } from '../src/shared/types';

let clock = 1_000;
const event = (role: TranscriptEvent['sourceRole'], text: string, isFinal = false): TranscriptEvent => ({
  text, isFinal, sourceId: role === 'remote_interviewer' ? 'system' : 'candidate', sourceKind: role === 'remote_interviewer' ? 'system' : 'microphone',
  sourceRole: role, canTriggerAnswers: role === 'remote_interviewer', confidence: 0.9, timestamp: clock,
});
/** Plays speech the way the app does: ownership decides who may take the box, then the store shows it. */
function live() {
  const ownership = new TranscriptOwnership(INTERVIEWER_OWNERSHIP_GRACE_MS, () => clock);
  const hear = (role: TranscriptEvent['sourceRole'], text: string, isFinal = false): void => {
    clock += 300;
    const value = event(role, text, isFinal);
    const echo = ownership.isEcho(value);
    useAppStore.getState().setTranscript(value, ownership.shouldClaim(value), echo);
  };
  return {
    ownership,
    interviewer: (text: string, isFinal = false) => hear('remote_interviewer', text, isFinal),
    me: (text: string, isFinal = false) => hear('local_candidate', text, isFinal),
    wait: (ms: number) => { clock += ms; },
    box: () => `${useAppStore.getState().activeTranscriptRole ?? 'none'}: ${useAppStore.getState().activeTranscript}`,
  };
}

describe('the live input box shows only the current speaker', () => {
  beforeEach(() => { useAppStore.getState().resetCopilot(); clock += 60_000; });

  it('switches to the customer, keeps their sentences together, and never brings the other speaker back', () => {
    const talk = live();
    talk.interviewer('Tell me about the event loop?', true);
    talk.wait(800);
    talk.me('So the event loop');
    expect(talk.box()).toBe('candidate: So the event loop');
    talk.me('So the event loop picks tasks.', true);
    talk.me('And microtasks');
    talk.me('And microtasks run first.', true);
    expect(talk.box()).toBe('candidate: So the event loop picks tasks. And microtasks run first.');
    // With Auto Answer off the app sends all unsent interviewer text; the box shows only the new part.
    talk.interviewer('Tell me about the event loop? Now explain');
    expect(talk.box()).toBe('interviewer: Now explain');
    talk.interviewer('Tell me about the event loop? Now explain async await?', true);
    expect(talk.box()).toBe('interviewer: Now explain async await?');
    // The top question box still receives everything the interviewer said.
    expect(useAppStore.getState().pendingInterviewerTranscript).toBe('Tell me about the event loop? Now explain async await?');
    talk.wait(800);
    talk.me('Async functions return promises.', true);
    expect(talk.box()).toBe('candidate: Async functions return promises.');
  });

  it('keeps the interviewer\'s question whole when the customer only says a short "yeah, sure" in a pause', () => {
    const talk = live();
    talk.interviewer('So tell me about a time when');
    talk.wait(800);
    talk.me('yeah sure', true);
    expect(talk.box()).toBe('candidate: yeah sure');
    talk.interviewer('So tell me about a time when you handled a conflict', true);
    expect(talk.box()).toBe('interviewer: So tell me about a time when you handled a conflict');
  });

  it('leaves the customer\'s words in place when a late copy of old interviewer text arrives', () => {
    const talk = live();
    talk.interviewer('What is a closure', false);
    talk.wait(800);
    talk.me('It remembers variables', false);
    talk.interviewer('What is a closure?', true);
    expect(talk.box()).toBe('candidate: It remembers variables');
  });

  it('starts afresh after the box is sent or cleared, or the question holding the old words is answered', () => {
    const talk = live();
    talk.interviewer('First question?', true);
    talk.wait(800);
    talk.me('My first answer', true);
    useAppStore.getState().releaseTalk();
    talk.me('More words', true);
    expect(talk.box()).toBe('candidate: More words');
    talk.interviewer('Second question?', true);
    expect(talk.box()).toBe('interviewer: Second question?');
    talk.wait(800); talk.me('thinking about it', true);
    useAppStore.getState().setQuestion({ question: 'Second question?', intent: 'TECHNICAL_QUESTION', confidence: 1, isComplete: true, isAnswerNeeded: true, requiresMoreContext: false });
    talk.interviewer('Second question about React?');
    expect(talk.box()).toBe('interviewer: Second question about React?');
  });

  it('takes the box for a short pause in the interviewer, but never for the speakers heard on the microphone', () => {
    const talk = live();
    talk.interviewer('Explain database transactions to me', true);
    talk.me('explain database transactions to me', true); // the speakers, heard on the microphone right away
    talk.wait(900);
    talk.me('Explain database transactions to me', true); // and again after the quiet gap
    expect(talk.box()).toBe('interviewer: Explain database transactions to me');
    talk.me('Sure, I can walk you through them', true);
    expect(talk.box()).toBe('candidate: Sure, I can walk you through them');
    expect(INTERVIEWER_OWNERSHIP_GRACE_MS).toBeLessThanOrEqual(800);
  });

  it('adds the customer\'s waiting words once the interviewer has been quiet long enough', () => {
    const talk = live();
    talk.interviewer('Your turn');
    const early = event('local_candidate', 'I would start with', false);
    useAppStore.getState().setTranscript(early, talk.ownership.shouldClaim(early), talk.ownership.isEcho(early));
    expect(talk.box()).toBe('interviewer: Your turn');
    expect(talk.ownership.candidateClaimDelay(early)).toBeGreaterThan(0);
    talk.wait(INTERVIEWER_OWNERSHIP_GRACE_MS);
    expect(talk.ownership.shouldClaim(early)).toBe(true);
    useAppStore.getState().claimTranscript(early);
    expect(talk.box()).toBe('candidate: I would start with');
  });
});

describe('what may refill a sent or cleared box', () => {
  it('only new words, not a late copy of what left it', () => {
    const handled = { text: 'How do promises work', at: 10_000 };
    expect(isNewSpeech('How do promises work?', handled, 10_500)).toBe(false);
    expect(isNewSpeech('promises work', handled, 10_500)).toBe(false);
    expect(isNewSpeech('How do promises work in JavaScript?', handled, 10_500)).toBe(true);
    expect(isNewSpeech('How do promises work?', handled, 15_000)).toBe(true); // asked again later
    expect(isNewSpeech('', handled, 10_500)).toBe(false);
    expect(isNewSpeech('anything', null, 0)).toBe(true);
  });
  it('removes words the box moved past, tolerating a corrected word, and keeps long questions within the limit', () => {
    expect(afterWords('What is a clojure? And hoisting?', 'What is a closure? What is a')).toBeNull();
    expect(afterWords('What is a closure? And hoisting?', 'what is a closure')).toBe('And hoisting?');
    expect(afterWords('What is the closure? And hoisting?', 'what is a closure and')).toBe('hoisting?');
    expect(afterWords('Something else entirely', 'what is a closure')).toBeNull();
    const long = 'word '.repeat(1_500).trim();
    expect(latestWords(long).length).toBeLessThanOrEqual(5_000);
    expect(latestWords(long).startsWith('word')).toBe(true);
    expect(latestWords('short question')).toBe('short question');
  });
});
