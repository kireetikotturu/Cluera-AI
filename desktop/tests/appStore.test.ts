import { beforeEach, describe, expect, it } from 'vitest';
import type { QuestionIntent, TranscriptEvent } from '../src/shared/types';
import { useAppStore } from '../src/renderer/stores/appStore';

const transcript = (text: string, sourceRole: TranscriptEvent['sourceRole'], isFinal = false): TranscriptEvent => ({
  text,
  isFinal,
  sourceId: sourceRole === 'local_candidate' ? 'candidate' : 'system',
  sourceKind: sourceRole === 'local_candidate' ? 'microphone' : 'system',
  sourceRole,
  canTriggerAnswers: sourceRole === 'remote_interviewer',
  confidence: 1,
  timestamp: Date.now(),
});

const question = (text: string): QuestionIntent => ({
  question: text,
  intent: 'GENERAL_QUESTION',
  confidence: 1,
  isAnswerNeeded: true,
  isComplete: true,
  requiresMoreContext: false,
});

describe('current interviewer interaction', () => {
  beforeEach(() => useAppStore.getState().resetCopilot());

  it('replaces a handled question as soon as a new interviewer turn begins', () => {
    const store = useAppStore.getState();
    store.setTranscript(transcript('Tell me about yourself', 'remote_interviewer', true));
    store.setQuestion(question('Tell me about yourself'));
    expect(useAppStore.getState().pendingInterviewerTranscript).toBe('');

    store.setTranscript(transcript('Now explain', 'remote_interviewer'));
    expect(useAppStore.getState().pendingInterviewerTranscript).toBe('Now explain');
    store.setTranscript(transcript('Now explain your latest project', 'remote_interviewer', true));
    expect(useAppStore.getState().pendingInterviewerTranscript).toBe('Now explain your latest project');
  });

  it('does not let candidate speech replace the pending interviewer interaction', () => {
    const store = useAppStore.getState();
    store.setTranscript(transcript('How did you solve that problem?', 'remote_interviewer'));
    store.setTranscript(transcript('I started by checking the logs', 'local_candidate'));
    expect(useAppStore.getState().pendingInterviewerTranscript).toBe('How did you solve that problem?');
  });

  it('releases an edited manual question so the next interviewer turn becomes current', () => {
    const store = useAppStore.getState();
    store.setTranscript(transcript('Tell me about your latest project', 'remote_interviewer', true));

    // The user may replace that visible transcript with a different question.
    // A successful manual send finishes the source interaction independently
    // of whether the submitted wording still matches it.
    store.finishInterviewerInteraction();
    expect(useAppStore.getState().pendingInterviewerTranscript).toBe('');

    store.setTranscript(transcript('How did you handle its main challenge', 'remote_interviewer'));
    expect(useAppStore.getState().pendingInterviewerTranscript).toBe('How did you handle its main challenge');
  });

  it('clears transient device-check speech without removing live Q&A navigation', () => {
    const store = useAppStore.getState();
    store.setQuestion(question('How would you secure an API?'));
    store.startAnswer('question-1');
    store.appendAnswer('Use layered authentication and authorization.');
    store.setTranscript(transcript('Testing the microphone', 'local_candidate', true));

    store.clearDeviceCheckTranscript();
    const state = useAppStore.getState();
    expect(state.activeTranscript).toBe('');
    expect(state.candidateTranscript).toBe('');
    expect(state.interviewerMessages).toEqual([]);
    expect(state.liveQaItems).toHaveLength(1);
    expect(state.liveQaItems[0].answer).toContain('layered authentication');
  });
});
