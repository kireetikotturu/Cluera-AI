import type { TranscriptEvent, TurnEvent } from '../../shared/types';

export interface SpeechRecognizer {
  start(): Promise<void>;
  sendAudio(chunk: Buffer): void;
  stop(): Promise<void>;
  onPartialTranscript(callback: (data: TranscriptEvent) => void): void;
  onFinalTranscript(callback: (data: TranscriptEvent) => void): void;
  onTurnEvent(callback: (event: TurnEvent) => void): void;
  onError(callback: (error: Error) => void): void;
}
