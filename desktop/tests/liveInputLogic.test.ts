import { describe, expect, it } from 'vitest';
import { AutoQuestionAssembler, ASSEMBLER_TIMING, questionGraceMs } from '../src/main/interview/autoQuestionAssembler';
import { TurnPrefixFilter } from '../src/main/interview/turnPrefixFilter';
import { IntentDetector } from '../src/main/interview/IntentDetector';
import { ReadingFocus, type ReadingState } from '../src/renderer/services/eyeContactScroll';
import { useAppStore } from '../src/renderer/stores/appStore';

describe('how long to wait before sending a spoken question', () => {
  it('answers a clear question almost at once', () => {
    expect(questionGraceMs('What is dependency injection?')).toBe(ASSEMBLER_TIMING.question);
    expect(questionGraceMs('Imagine a service with a million users. How would you scale it?')).toBe(ASSEMBLER_TIMING.question);
  });
  it('waits a little for a finished sentence that asks for something', () => {
    expect(questionGraceMs('Tell me about a project you are proud of.')).toBe(ASSEMBLER_TIMING.statement);
    expect(questionGraceMs('Explain how you would scale it.')).toBe(ASSEMBLER_TIMING.statement);
  });
  it('waits longer when the speaker stopped in the middle of a sentence', () => {
    expect(questionGraceMs('So in that situation, how would you')).toBe(ASSEMBLER_TIMING.incomplete);
    expect(questionGraceMs('Tell me about your experience with')).toBe(ASSEMBLER_TIMING.incomplete);
  });
  it('waits for the real question after a situation is described', () => {
    expect(questionGraceMs('Imagine you have a payments service that handles a million requests a day.')).toBe(ASSEMBLER_TIMING.setup);
    expect(questionGraceMs('Suppose your team inherits a legacy codebase with no tests.')).toBe(ASSEMBLER_TIMING.setup);
    expect(questionGraceMs('Say you have a service that slows down at night. Explain how you would find the cause.')).toBe(ASSEMBLER_TIMING.statement);
  });
  it('is unsure about very short or unpunctuated text, but still answers soon', () => {
    expect(questionGraceMs('Okay thanks.')).toBe(ASSEMBLER_TIMING.uncertain);
    expect(questionGraceMs('what is the difference between a process and a thread')).toBeLessThan(ASSEMBLER_TIMING.incomplete);
  });
  it('stops waiting once a question has grown very long or been held too long', () => {
    expect(questionGraceMs('Imagine a service. '.repeat(120))).toBeLessThanOrEqual(250);
    expect(questionGraceMs('Imagine you have a payments service.', ASSEMBLER_TIMING.maximumHold)).toBeLessThanOrEqual(300);
    expect(questionGraceMs('')).toBe(0);
  });
});

describe('collecting the pieces of a question', () => {
  function build() {
    const timers: Array<{ id: number; at: number; run: () => void }> = [];
    let now = 0;
    let nextId = 1;
    const asked: string[] = [];
    const assembler = new AutoQuestionAssembler({
      ready: (question) => asked.push(question),
      now: () => now,
      schedule: (run, ms) => { const timer = { id: nextId++, at: now + ms, run }; timers.push(timer); return timer.id; },
      cancel: (handle) => { const index = timers.findIndex((timer) => timer.id === handle); if (index >= 0) timers.splice(index, 1); },
    });
    const advance = (ms: number): void => {
      const until = now + ms;
      for (;;) {
        const due = timers.filter((timer) => timer.at <= until).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers.splice(timers.indexOf(due), 1);
        now = due.at;
        due.run();
      }
      now = until;
    };
    return { assembler, asked, advance };
  }

  it('sends one question after the speaker stays quiet', () => {
    const { assembler, asked, advance } = build();
    assembler.turnEnded('What is dependency injection?');
    advance(ASSEMBLER_TIMING.question - 1);
    expect(asked).toEqual([]);
    advance(2);
    expect(asked).toEqual(['What is dependency injection?']);
    expect(assembler.pending).toBe('');
  });
  it('joins a question the interviewer pauses in, instead of answering the first piece', () => {
    const { assembler, asked, advance } = build();
    assembler.turnEnded('Imagine you have a payments service that handles a million requests a day.');
    advance(1_500);
    assembler.hold();                                   // the interviewer starts talking again
    advance(4_000);
    expect(asked).toEqual([]);                          // still waiting: they have not finished
    assembler.turnEnded('Sometimes it slows down at night. How would you find the cause?');
    expect(assembler.pending).toContain('Imagine you have a payments service');
    advance(ASSEMBLER_TIMING.question + 1);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toBe('Imagine you have a payments service that handles a million requests a day. Sometimes it slows down at night. How would you find the cause?');
  });
  it('restarts the wait when a new turn ends before the old wait is over', () => {
    const { assembler, asked, advance } = build();
    assembler.turnEnded('Tell me about your experience with');
    advance(1_000);
    assembler.turnEnded('microservices and message queues?');
    advance(ASSEMBLER_TIMING.question - 1);
    expect(asked).toEqual([]);
    advance(2);
    expect(asked).toEqual(['Tell me about your experience with microservices and message queues?']);
  });
  it('never sends text that was discarded', () => {
    const { assembler, asked, advance } = build();
    assembler.turnEnded('Tell me about your experience with');
    assembler.discard();
    advance(10_000);
    expect(asked).toEqual([]);
    expect(assembler.pending).toBe('');
  });
  it('ignores an empty turn when nothing is waiting', () => {
    const { assembler, asked, advance } = build();
    expect(assembler.turnEnded('   ')).toBe('');
    advance(10_000);
    expect(asked).toEqual([]);
  });
});

describe('what Clear removes from a speech turn', () => {
  it('hides the cleared words when the same turn carries on, and shows only the new words', () => {
    const filter = new TurnPrefixFilter();
    expect(filter.observe('Tell me about your')).toBe('Tell me about your');
    filter.discard();
    expect(filter.observe('Tell me about your')).toBe('');
    expect(filter.observe('Tell me about your experience with React')).toBe('experience with React');
    expect(filter.observe('Tell me about your experience with React and Node?')).toBe('experience with React and Node?');
    filter.endTurn();
    expect(filter.observe('What is Node?')).toBe('What is Node?');
  });
  it('shows the next turn in full', () => {
    const filter = new TurnPrefixFilter();
    filter.observe('What is a closure?');
    filter.discard();
    expect(filter.observe('Completely different question about databases')).toBe('Completely different question about databases');
    expect(filter.hasDiscarded).toBe(false);
  });
  it('copes with the speech service correcting an earlier word and with punctuation', () => {
    const filter = new TurnPrefixFilter();
    filter.observe('Tell me about your experience with reacts');
    filter.discard();
    expect(filter.observe('Tell me, about your experience with React, and node')).toBe('and node');
  });
  it('does nothing until something has been cleared', () => {
    const filter = new TurnPrefixFilter();
    expect(filter.observe('Hello there')).toBe('Hello there');
    expect(filter.hasDiscarded).toBe(false);
  });
});

describe('a scenario question reaches the AI whole', () => {
  it('keeps the situation and the question together, but still trims chatter before an ordinary question', () => {
    const detector = new IntentDetector();
    const scenario = 'Imagine you have a payments service that handles a million requests a day. Sometimes it slows down at night. How would you find the cause?';
    expect(detector.detect(scenario).question).toBe(scenario);
    expect(detector.detect('Great, thanks for that. What is dependency injection?').question).toBe('What is dependency injection?');
  });
});

describe('Clear on the live input', () => {
  it('drops unsent spoken text everywhere but keeps the answer reading progress', () => {
    useAppStore.setState({ pendingInterviewerTranscript: 'half a question', transcript: 'half a question', activeTranscript: 'half a question',
      activeTranscriptRole: 'interviewer', interviewerSpeaking: true, candidateTranscript: 'my words', candidateReadingTranscript: 'I started reading' });
    useAppStore.getState().discardLiveInput();
    const state = useAppStore.getState();
    expect(state.pendingInterviewerTranscript).toBe('');
    expect(state.transcript).toBe('');
    expect(state.activeTranscript).toBe('');
    expect(state.activeTranscriptRole).toBeNull();
    expect(state.interviewerSpeaking).toBe(false);
    expect(state.candidateTranscript).toBe('');
    expect(state.candidateReadingTranscript).toBe('I started reading');
  });
});

describe('typing a question while an answer is on screen', () => {
  const base: ReadingState = { enabled: true, hidden: false, turn: 1, questionId: 'q1', hasAnswer: true, pendingQuestion: false, speaking: false, submitting: false, word: 0 };
  it('moves the view back to the question and keeps it there until the next answer arrives', () => {
    const focus = new ReadingFocus();
    focus.update(base);
    focus.update({ ...base, word: 3 });
    expect(focus.mode).toBe('answer');
    focus.focusQuestion();
    expect(focus.mode).toBe('question');
    focus.update({ ...base, word: 4 });                   // the old answer must not pull the view back
    expect(focus.mode).toBe('question');
    focus.update({ ...base, questionId: 'q2', hasAnswer: false, submitting: true });
    focus.update({ ...base, questionId: 'q2', hasAnswer: true, word: 0 });
    expect(focus.mode).toBe('answer');
  });
});
