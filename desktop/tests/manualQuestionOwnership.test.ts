import { beforeEach, describe, expect, it } from 'vitest';
import { ManualQuestionOwnership } from '../src/renderer/services/manualQuestionOwnership';
import { useAppStore } from '../src/renderer/stores/appStore';

describe('manual top question turn ownership (real transcript store)', () => {
  let owner: ManualQuestionOwnership;
  let draft: string;
  let timestamp: number;
  const state = () => useAppStore.getState();
  const render = () => {
    const s = state();
    const decision = owner.observe(s.interviewerTurnSequence, Boolean(s.pendingInterviewerTranscript));
    if (decision.acceptTranscript) draft = s.pendingInterviewerTranscript;
    return decision;
  };
  const speech = (text: string, isFinal = false, renderNow = true) => {
    state().setTranscript({ text, isFinal, timestamp: ++timestamp, sourceId: 'system', sourceKind: 'system',
      sourceRole: 'remote_interviewer', canTriggerAnswers: true, confidence: .95 });
    if (renderNow) render();
  };
  const edit = (text: string) => { owner.edit(state().interviewerTurnSequence); draft = text; };
  beforeEach(() => { state().resetCopilot(); owner = new ManualQuestionOwnership(); draft = ''; timestamp = 100; });

  it('populates the first speech and keeps partial/final updates transcript-owned', () => {
    speech('Explain'); speech('Explain the architecture'); speech('Explain the architecture?', true);
    expect(draft).toBe('Explain the architecture?');
    expect(state().interviewerTurnSequence).toBe(1);
  });
  it.each(['', 'My edited question'])('preserves edit %j through this turn and repopulates on the next', text => {
    speech('First question'); edit(text);
    speech('First question continued'); speech('First question completed', true);
    expect(draft).toBe(text);
    speech('Second question');
    expect(draft).toBe('Second question');
    expect(owner.edited).toBe(false);
  });
  it('does not let repeated finals claim ownership after deletion', () => {
    speech('Same final?', true); edit(''); speech('Same final?', true);
    expect(draft).toBe('');
    expect(state().interviewerTurnSequence).toBe(1);
  });
  it('protects a typed question from older partials belonging to the same active turn', () => {
    speech('Interviewer start'); edit('My own typed question'); speech('Interviewer start continued');
    expect(draft).toBe('My own typed question');
    expect(owner.edited).toBe(true);
  });
  it.each(['Enter', 'Send'])('%s consumes only this turn; late chunks do not replay it', () => {
    speech('Original'); edit('Exact replacement');
    const sent = owner.snapshot(state().interviewerTurnSequence);
    expect(owner.finish(sent, state().interviewerTurnSequence)).toBe(true);
    state().finishInterviewerInteraction();
    speech('Original continued'); speech('Original finalized', true);
    expect(draft).toBe('Exact replacement');
    speech('New question'); expect(draft).toBe('New question');
  });
  it('does not clear a newer turn when an older answer request resolves', () => {
    speech('First', true);
    const sent = owner.snapshot(state().interviewerTurnSequence);
    speech('Second', false, false); // even before React's next layout effect
    expect(owner.finish(sent, state().interviewerTurnSequence)).toBe(false);
    render(); expect(draft).toBe('Second');
  });
  it('does not clear edits made while a request is pending', () => {
    speech('First'); const sent = owner.snapshot(state().interviewerTurnSequence);
    edit('Typed while pending');
    expect(owner.isCurrent(sent, state().interviewerTurnSequence)).toBe(false);
    expect(owner.finish(sent, state().interviewerTurnSequence)).toBe(false);
    render(); expect(draft).toBe('Typed while pending');
  });
  it('recovers after collapsed rendering and rapid turns, without depending on an empty transcript', () => {
    speech('First'); edit(''); speech('First final', true, false);
    speech('Second', false, false); speech('Second final', true, false);
    render(); expect(draft).toBe('Second final');
    for (let i = 0; i < 250; i++) {
      speech(`Question ${i}`); expect(draft).toBe(`Question ${i}`);
      edit(''); speech(`Question ${i} final`, true); expect(draft).toBe('');
    }
  });
  it('leaves accumulated/long transcript text intact and resets on Auto Answer mode switch', () => {
    const text = 'Long accumulated transcript. '.repeat(1000);
    speech(text, true); expect(draft).toBe(text.trim());
    edit(''); owner.reset(); render();
    expect(draft).toBe(text.trim());
  });
});
