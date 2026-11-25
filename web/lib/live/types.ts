import type { AnswerLength, AnswerPreferences, InterviewType, SessionKind } from '../../../desktop/src/shared/types';

/** Everything chosen on the setup screen. The résumé, job description and notes are plain text read from the account. */
export interface LiveSetup {
  id: string;
  kind: SessionKind;
  title: string;
  role: string;
  company: string;
  interviewType: InterviewType;
  language: string;
  answerLength: AnswerLength;
  answerStyle: string;
  answerPreferences: AnswerPreferences;
  /** The customer's own notes for the AI (the box that starts with the Admin's default text). */
  instructions: string;
  resumeText: string;
  jobDescription: string;
  supporting: Array<{ name: string; text: string }>;
  /** Names only, for the history. */
  documentNames: string[];
  modelId: string;
  /** Whether the selected model can read a photo. */
  modelReadsImages: boolean;
  autoAnswer: boolean;
  saveHistory: boolean;
}

export type TurnSource = 'voice' | 'typed' | 'photo';
export type TurnState = 'writing' | 'done' | 'failed' | 'cancelled';

export interface LiveTurn {
  id: string;
  question: string;
  answer: string;
  at: string;
  model?: string;
  source: TurnSource;
  state: TurnState;
  /** Why it failed, in words for the customer. */
  note?: string;
  /** A small preview of the photo that was sent (data URL), kept only on this screen. */
  photo?: string;
}

export type LiveStatus = 'idle' | 'connecting' | 'listening' | 'reconnecting' | 'ended' | 'error';

export interface LiveSnapshot {
  status: LiveStatus;
  /** A plain sentence about the state, for example why the session ended. */
  message: string;
  paused: boolean;
  autoAnswer: boolean;
  /** What is being said right now. */
  heard: string;
  /** With Auto Answer off: the question collected so far, waiting for Send. */
  collected: string;
  turns: LiveTurn[];
  /** The answer that is being written, if any. */
  activeTurnId: string | null;
  startedAt: number;
  modelId: string;
  answerLength: AnswerLength;
  /** Increases whenever a new question appears, so the screen can scroll to it. */
  questionSequence: number;
}

export interface AccessGrant { accessToken: string; expiresInMs: number; relayEndpoint: string }

export type RelayChannel = 'interviewer' | 'candidate';
export type RelayIncoming =
  | { type: 'ready' }
  | { type: 'sessionEnded' }
  | { type: 'answer'; id: string; text: string }
  | { type: 'answerDone'; id: string }
  | { type: 'answerFailed'; id: string }
  | { type: 'audioReady'; channel: RelayChannel }
  | { type: 'transcript'; channel: RelayChannel; event: 'StartOfTurn' | 'EagerEndOfTurn' | 'TurnResumed' | 'EndOfTurn' | 'Update'; transcript: string };

export type RelayCommand =
  | { type: 'generate'; id: string; prompt: string; modelId?: string; maxTokens?: number; image?: { mimeType: 'image/jpeg' | 'image/png' | 'image/webp'; data: string } }
  | { type: 'cancelGeneration' }
  | { type: 'openAudio'; channel: RelayChannel; keyterms?: string[] }
  | { type: 'closeAudio'; channel: RelayChannel }
  | { type: 'forceEndTurn'; channel: RelayChannel }
  | { type: 'stop' };

/** The part of a browser WebSocket the live session uses, so tests can stand in for it. */
export interface SocketLike {
  readyState: number;
  bufferedAmount: number;
  binaryType: string;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string | ArrayBufferLike | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
}
