import { create } from 'zustand';
import type {
  AppSettings, CopilotStatus, ProviderStatus, QuestionIntent, ScreenCapturePreview, ScreenContext, Session, TelemetrySnapshot, TranscriptEvent,
} from '../../shared/types';
import { afterWords, EMPTY_TALK, hearInterviewer, hearMe, takeOver, type TalkMemory } from '../services/liveTalk';

export type Page = 'home' | 'create' | 'copilot' | 'history' | 'settings' | 'files';

export interface InterviewerChatMessage {
  id: string;
  text: string;
  timestamp: number;
  handled: boolean;
}

export interface LiveQaItem {
  questionId: string;
  question: QuestionIntent | null;
  answer: string;
  telemetry: TelemetrySnapshot | null;
  streaming: boolean;
  /** Ended without completing: it could not be generated, or another question replaced it. */
  stopped?: 'failed' | 'replaced';
}

const normalizedTranscript = (text: string): string => text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

interface AppState {
  page: Page;
  sessions: Session[];
  activeSessionId: string | null;
  providerStatus: ProviderStatus | null;
  settings: AppSettings | null;
  copilotStatus: CopilotStatus;
  statusMessage: string;
  transcript: string;
  pendingInterviewerTranscript: string;
  interviewerTurnSequence: number;
  interviewerSpeaking: boolean;
  candidateTranscript: string;
  candidateReadingTranscript: string;
  activeTranscript: string;
  activeTranscriptRole: 'interviewer' | 'candidate' | null;
  /** What the live input box needs to show only the current speaker's words. */
  talk: TalkMemory;
  interviewerMessages: InterviewerChatMessage[];
  liveQaItems: LiveQaItem[];
  activeQaIndex: number;
  screenPreview: ScreenCapturePreview | null;
  screenContext: ScreenContext | null;
  question: QuestionIntent | null;
  answer: string;
  activeAnswerId: string | null;
  answerCaptureId: string | null;
  telemetry: TelemetrySnapshot | null;
  error: string | null;
  /** The account's time ran out during a live session; the dashboard explains it until closed. */
  timeOver: boolean;
  setTimeOver(timeOver: boolean): void;
  setPage(page: Page): void;
  setSessions(sessions: Session[]): void;
  setActiveSession(id: string | null): void;
  setProviderStatus(status: ProviderStatus): void;
  setSettings(settings: AppSettings): void;
  setCopilotStatus(status: CopilotStatus, message?: string): void;
  /** `echo`: the microphone heard the interviewer from the speakers, so it never reaches the input box. */
  setTranscript(event: TranscriptEvent, claimActive?: boolean, echo?: boolean): void;
  claimTranscript(event: TranscriptEvent): void;
  /** The box was sent, cleared or restarted: the next words begin a new talk. */
  releaseTalk(): void;
  clearTranscript(): void;
  clearDeviceCheckTranscript(): void;
  clearCandidateTranscript(): void;
  clearInterviewerMessages(): void;
  discardLiveInput(): void;
  finishInterviewerInteraction(): void;
  markInterviewerMessageHandled(text: string): void;
  selectQa(index: number): void;
  setScreenPreview(preview: ScreenCapturePreview | null): void;
  setScreenContext(context: ScreenContext | null): void;
  setQuestion(question: QuestionIntent): void;
  resolveQuestion(questionId: string, question: QuestionIntent): void;
  startAnswer(questionId?: string, captureId?: string): void;
  appendAnswer(token: string): void;
  finishAnswer(answer: string, telemetry: TelemetrySnapshot): void;
  stopAnswer(questionId: string, failed: boolean): void;
  setError(error: string | null): void;
  resetCopilot(): void;
}

export const useAppStore = create<AppState>((set) => ({
  page: 'home', sessions: [], activeSessionId: null, providerStatus: null, settings: null,
  interviewerTurnSequence: 0, interviewerSpeaking: false,
  copilotStatus: 'idle', statusMessage: '', transcript: '', pendingInterviewerTranscript: '', candidateTranscript: '', candidateReadingTranscript: '', activeTranscript: '', activeTranscriptRole: null, talk: EMPTY_TALK, interviewerMessages: [], liveQaItems: [], activeQaIndex: -1, screenPreview: null, screenContext: null, question: null, answer: '', telemetry: null, error: null, timeOver: false,
  setTimeOver: (timeOver) => set({ timeOver }),
  setPage: (page) => set({ page }), setSessions: (sessions) => set({ sessions }), setActiveSession: (activeSessionId) => set({ activeSessionId }),
  setProviderStatus: (providerStatus) => set({ providerStatus }), setSettings: (settings) => set({ settings }),
  setCopilotStatus: (copilotStatus, statusMessage = '') => set({ copilotStatus, statusMessage }),
  setTranscript: (event, claimActive = true, echo = false) => set((state) => {
    if (event.sourceRole === 'local_candidate') {
      const spoken = event.text.trim();
      const candidateReadingTranscript = event.isFinal && spoken
        ? `${state.candidateReadingTranscript} ${spoken}`.trim().slice(-20_000)
        : state.candidateReadingTranscript;
      const heard = echo || !spoken ? null : hearMe(state.talk, spoken, event.isFinal);
      let talk = heard?.memory ?? state.talk;
      const claim = claimActive && heard !== null;
      if (claim) talk = takeOver(talk, heard.show);
      return {
        candidateTranscript: event.text,
        candidateReadingTranscript,
        talk,
        ...(claim ? { activeTranscript: heard.show, activeTranscriptRole: 'candidate' as const } : {}),
      };
    }
    const text = event.text.trim();
    const box = text ? hearInterviewer(state.talk, text, state.activeTranscriptRole === 'candidate') : null;
    const talk = box?.memory ?? state.talk;
    // Nothing new for the box (only words it has moved past): leave what it shows.
    const claim = claimActive && (box === null || box.show !== '')
      ? { activeTranscript: box?.show ?? event.text, activeTranscriptRole: 'interviewer' as const } : {};
    const latest = state.interviewerMessages.at(-1);
    const isRepeatedFinal = event.isFinal && latest
      && normalizedTranscript(latest.text) === normalizedTranscript(text)
      && Math.abs(event.timestamp - latest.timestamp) < 5_000;
    // Transient UI turn boundary only; never changes transcription or AI routing.
    const speaking = {
      interviewerTurnSequence: state.interviewerTurnSequence + (text && !state.interviewerSpeaking && !isRepeatedFinal ? 1 : 0),
      interviewerSpeaking: Boolean(text) && !event.isFinal,
    };
    if (!event.isFinal || !text) return { ...speaking, transcript: text, pendingInterviewerTranscript: text, talk, ...claim };
    return {
      ...speaking,
      transcript: text,
      pendingInterviewerTranscript: text,
      talk,
      ...claim,
      interviewerMessages: isRepeatedFinal
        ? state.interviewerMessages
        : [...state.interviewerMessages, { id: `${event.timestamp}-${state.interviewerMessages.length}`, text, timestamp: event.timestamp, handled: false }].slice(-50),
    };
  }),
  claimTranscript: (event) => set((state) => {
    if (event.sourceRole !== 'local_candidate') return { activeTranscript: event.text, activeTranscriptRole: 'interviewer' as const };
    // A finished sentence is already part of the customer's talk; an unfinished one is added to what they said before.
    const show = event.isFinal && state.talk.mine ? state.talk.mine : hearMe(state.talk, event.text, false).show;
    return {
      talk: takeOver(state.talk, show),
      activeTranscript: show,
      activeTranscriptRole: 'candidate' as const,
    };
  }),
  releaseTalk: () => set({ talk: EMPTY_TALK }),
  clearTranscript: () => set({ interviewerSpeaking: false, transcript: '', pendingInterviewerTranscript: '', candidateTranscript: '', candidateReadingTranscript: '', activeTranscript: '', activeTranscriptRole: null, talk: EMPTY_TALK, interviewerMessages: [], liveQaItems: [], activeQaIndex: -1 }),
  clearDeviceCheckTranscript: () => set({ interviewerSpeaking: false, transcript: '', pendingInterviewerTranscript: '', candidateTranscript: '', candidateReadingTranscript: '', activeTranscript: '', activeTranscriptRole: null, talk: EMPTY_TALK, interviewerMessages: [] }),
  clearCandidateTranscript: () => set((state) => ({
    candidateTranscript: '',
    candidateReadingTranscript: '',
    talk: { ...state.talk, mine: '' },
    ...(state.activeTranscriptRole === 'candidate' ? { activeTranscript: '', activeTranscriptRole: null } : {}),
  })),
  clearInterviewerMessages: () => set({ interviewerMessages: [], transcript: '', pendingInterviewerTranscript: '' }),
  // Clear pressed on the live input: drop the unsent spoken text everywhere so it cannot be shown or sent again.
  discardLiveInput: () => set({ interviewerSpeaking: false, transcript: '', pendingInterviewerTranscript: '', candidateTranscript: '', activeTranscript: '', activeTranscriptRole: null, talk: EMPTY_TALK }),
  finishInterviewerInteraction: () => set({ pendingInterviewerTranscript: '' }),
  markInterviewerMessageHandled: (text) => set((state) => {
    const target = normalizedTranscript(text);
    let matched = false;
    const interviewerMessages = state.interviewerMessages.map((message, index, messages) => {
      if (matched || message.handled || normalizedTranscript(message.text) !== target) return message;
      const laterMatch = messages.slice(index + 1).some((later) => !later.handled && normalizedTranscript(later.text) === target);
      if (laterMatch) return message;
      matched = true;
      return { ...message, handled: true };
    });
    const pending = normalizedTranscript(state.pendingInterviewerTranscript);
    return {
      interviewerMessages,
      pendingInterviewerTranscript: pending === target ? '' : state.pendingInterviewerTranscript,
    };
  }),
  selectQa: (index) => set((state) => {
    if (!state.liveQaItems.length) return {};
    const activeQaIndex = Math.max(0, Math.min(index, state.liveQaItems.length - 1));
    const selected = state.liveQaItems[activeQaIndex];
    return { activeQaIndex, question: selected.question, answer: selected.answer, telemetry: selected.telemetry };
  }),
  setScreenPreview: (screenPreview) => set({ screenPreview }), setScreenContext: (screenContext) => set({ screenContext }), setQuestion: (question) => {
    const target = normalizedTranscript(question.question);
    set((state) => {
      const pending = normalizedTranscript(state.pendingInterviewerTranscript);
      const handlesPending = Boolean(pending && target && (
        pending === target || pending.endsWith(target) || target.endsWith(pending)
      ));
      // A question holding the words the box had moved past was sent: the interviewer's text starts afresh after it.
      const sentPassed = Boolean(state.talk.interviewerPassed) && afterWords(question.question, state.talk.interviewerPassed) !== null;
      return {
        question,
        talk: sentPassed ? { ...state.talk, interviewerPassed: '' } : state.talk,
        pendingInterviewerTranscript: handlesPending ? '' : state.pendingInterviewerTranscript,
        interviewerMessages: state.interviewerMessages.map((message) => (
          normalizedTranscript(message.text) === target ? { ...message, handled: true } : message
        )),
      };
    });
  },
  resolveQuestion: (questionId, question) => set((state) => {
    const itemIndex = state.liveQaItems.findIndex((item) => item.questionId === questionId);
    if (itemIndex < 0) return state.activeAnswerId === questionId ? { question } : {};
    const liveQaItems = state.liveQaItems.map((item, index) => index === itemIndex ? { ...item, question } : item);
    return {
      liveQaItems,
      question: state.activeQaIndex === itemIndex ? question : state.question,
    };
  }),
  activeAnswerId: null, answerCaptureId: null,
  startAnswer: (questionId, captureId) => set((state) => {
    if (!questionId) return { answer: '', telemetry: null, error: null, answerCaptureId: captureId ?? null };
    const existingIndex = state.liveQaItems.findIndex((item) => item.questionId === questionId);
    const nextItem: LiveQaItem = { questionId, question: state.question, answer: '', telemetry: null, streaming: true };
    const liveQaItems = existingIndex >= 0
      ? state.liveQaItems.map((item, index) => index === existingIndex ? nextItem : item)
      : [...state.liveQaItems, nextItem].slice(-50);
    const activeQaIndex = existingIndex >= 0 ? existingIndex : liveQaItems.length - 1;
    return { answer: '', telemetry: null, error: null, activeAnswerId: questionId, answerCaptureId: captureId ?? null, liveQaItems, activeQaIndex, candidateReadingTranscript: '', candidateTranscript: '' };
  }),
  appendAnswer: (token) => set((state) => {
    const itemIndex = state.liveQaItems.findIndex((item) => item.questionId === state.activeAnswerId);
    if (itemIndex < 0) return { answer: state.answer + token };
    const liveQaItems = state.liveQaItems.map((item, index) => index === itemIndex ? { ...item, answer: item.answer + token } : item);
    return { liveQaItems, answer: state.activeQaIndex === itemIndex ? liveQaItems[itemIndex].answer : state.answer };
  }),
  finishAnswer: (answer, telemetry) => set((state) => {
    const itemIndex = state.liveQaItems.findIndex((item) => item.questionId === state.activeAnswerId);
    if (itemIndex < 0) return { answer, telemetry };
    const liveQaItems = state.liveQaItems.map((item, index) => index === itemIndex ? { ...item, answer, telemetry, streaming: false } : item);
    return { liveQaItems, answer: state.activeQaIndex === itemIndex ? answer : state.answer, telemetry: state.activeQaIndex === itemIndex ? telemetry : state.telemetry };
  }),
  stopAnswer: (questionId, failed) => set((state) => {
    if (!state.liveQaItems.some((item) => item.questionId === questionId && item.streaming)) return {};
    return { liveQaItems: state.liveQaItems.map((item) => item.questionId === questionId
      ? { ...item, streaming: false, stopped: failed ? 'failed' as const : 'replaced' as const } : item) };
  }),
  setError: (error) => set({ error }),
  resetCopilot: () => set({ interviewerTurnSequence: 0, interviewerSpeaking: false, copilotStatus: 'idle', statusMessage: '', transcript: '', pendingInterviewerTranscript: '', candidateTranscript: '', candidateReadingTranscript: '', activeTranscript: '', activeTranscriptRole: null, talk: EMPTY_TALK, interviewerMessages: [], liveQaItems: [], activeQaIndex: -1, screenPreview: null, screenContext: null, question: null, answer: '', activeAnswerId: null, answerCaptureId: null, telemetry: null, error: null }),
}));
