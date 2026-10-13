import type { AnswerContext } from '../../shared/types';

export interface AnswerModel {
  readonly name: string;
  streamAnswer(context: AnswerContext, signal: AbortSignal): AsyncIterable<string>;
}
