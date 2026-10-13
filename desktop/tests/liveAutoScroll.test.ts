import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FormattedAnswer } from '../src/renderer/components/FormattedAnswer';
import { ReadingFocus, type ReadingState } from '../src/renderer/services/eyeContactScroll';
import { useAppStore } from '../src/renderer/stores/appStore';
import type { TranscriptEvent } from '../src/shared/types';

describe('live Auto Scroll', () => {
  it('retains invisible word anchors without any read/current class or inline marking', () => {
    const html = renderToStaticMarkup(createElement(FormattedAnswer, { text: '# Heading\n\nRead **these words** and `code`.\n\n```ts\nconst a = 1;\n```' }));
    expect(html).toContain('data-answer-word-index="0"');
    expect(html).not.toMatch(/answer-word-(spoken|current)|style=/);
    expect(html).toContain('<strong class="answer-key-phrase">');
    expect(html).toContain('<pre>');
  });

  const state: ReadingState = { enabled: true, hidden: false, turn: 1, questionId: 'old', hasAnswer: true, pendingQuestion: false, speaking: false, submitting: false, word: 20 };
  it('gives a new question ownership until its new answer starts', () => {
    const focus = new ReadingFocus();
    expect(focus.update(state)).toBe(true); expect(focus.mode).toBe('answer');
    const question = { ...state, turn: 2, pendingQuestion: true, speaking: true };
    focus.update(question); expect(focus.mode).toBe('question');
    focus.update({ ...question, speaking: false, word: 80 }); expect(focus.mode).toBe('question');
    focus.update({ ...question, speaking: false, questionId: 'new', word: -1 });
    expect(focus.mode).toBe('answer');
    focus.update({ ...question, speaking: false, questionId: 'new', word: 0 });
    expect(focus.mode).toBe('answer');
  });
  it('consumes OFF/hidden transitions and synchronizes the relevant anchor on resume', () => {
    const focus = new ReadingFocus();
    expect(focus.update({ ...state, enabled: false })).toBe(false);
    expect(focus.update(state)).toBe(true); expect(focus.mode).toBe('answer');
    expect(focus.update({ ...state, turn: 2, hidden: true, pendingQuestion: true })).toBe(false);
    expect(focus.update({ ...state, turn: 2, pendingQuestion: true })).toBe(true);
    expect(focus.mode).toBe('question');
  });
  it('holds manual scrolling until new reading progress, but a new question wins', () => {
    const focus = new ReadingFocus(); focus.update(state); focus.hold(20);
    expect(focus.update(state)).toBe(false);
    expect(focus.update({ ...state, word: 21 })).toBe(true);
    focus.hold(21);
    expect(focus.update({ ...state, turn: 2, pendingQuestion: true })).toBe(true);
    expect(focus.mode).toBe('question');
  });
  it('opens a newly selected Q&A at its beginning until newer reading progress arrives', () => {
    const focus = new ReadingFocus(); focus.update(state);
    focus.update({ ...state, questionId: 'history', word: 80 }); expect(focus.word).toBe(0);
    focus.update({ ...state, questionId: 'history', word: 80 }); expect(focus.word).toBe(0);
    focus.update({ ...state, questionId: 'history', word: 81 }); expect(focus.word).toBe(81);
  });
  it('does not mistake an old visible answer for a new answer when mounting with a pending question', () => {
    const focus = new ReadingFocus(); focus.update({ ...state, pendingQuestion: true });
    expect(focus.mode).toBe('question');
    focus.update({ ...state, pendingQuestion: true, hidden: true, turn: 2 });
    focus.update({ ...state, pendingQuestion: false, hidden: true, turn: 2, questionId: 'next' });
    focus.update({ ...state, pendingQuestion: false, turn: 2, questionId: 'next' });
    expect(focus.mode).toBe('answer');
  });

  it('tracks only genuine interviewer boundaries, not partials, candidate speech or duplicate finals', () => {
    const store = useAppStore.getState();
    store.resetCopilot();
    useAppStore.setState({ interviewerTurnSequence: 0, interviewerSpeaking: false });
    const event: TranscriptEvent = { text: 'How', isFinal: false, timestamp: 1, sourceId: 'system', sourceKind: 'system', sourceRole: 'remote_interviewer', canTriggerAnswers: true, confidence: .9 };
    store.setTranscript(event);
    store.setTranscript({ ...event, text: 'How does it work?' });
    expect(useAppStore.getState().interviewerTurnSequence).toBe(1);
    expect(useAppStore.getState().interviewerSpeaking).toBe(true);
    store.setTranscript({ ...event, sourceRole: 'local_candidate', text: 'Candidate noise' });
    expect(useAppStore.getState().interviewerTurnSequence).toBe(1);
    store.setTranscript({ ...event, text: 'How does it work?', isFinal: true });
    store.setTranscript({ ...event, text: 'How does it work?', isFinal: true });
    expect(useAppStore.getState().interviewerSpeaking).toBe(false);
    expect(useAppStore.getState().interviewerTurnSequence).toBe(1);
    store.setTranscript({ ...event, text: 'And why?' });
    expect(useAppStore.getState().interviewerTurnSequence).toBe(2);
    store.resetCopilot();
  });
});
