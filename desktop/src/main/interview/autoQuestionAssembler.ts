import { mergeFinalTranscriptText } from './mergeTranscript';

const QUESTION_START = /^(what|why|how|when|where|which|who|can|could|would|will|do|did|have|has|are|is|tell|describe|explain|walk|give|share|design|implement|write|solve|analyze|analyse|compare)\b/i;
const ASK_PHRASE = /\b(tell me|walk me through|talk about|introduce yourself|your thoughts|what would you|how would you|how do you|would you|can you|could you|explain|describe)\b/i;
export const SCENARIO_CUE =/^(?:suppose|imagine|let'?s say|consider|assume|say you|you have|you are|you're|you were|given|there is|there's|there are|we have|we are|we're|our (?:team|company|system|service|app)|in this scenario|scenario|case|a (?:client|customer|user|team|company))\b/i;
const INCOMPLETE_TAIL = /\b(and|or|also|because|when|while|with|about|to|for|on|in|using|through|but|so|then|if|that|which|where|the|a|an|of|is|are|was|were|how you|what you|tell me|how would you|how do you|how can you|how could you|what would you|what do you|would you|could you|can you|do you|did you|have you|are you|were you|will you|should you|you)\s*[,…]*$/i;

export const ASSEMBLER_TIMING = {
  /** A clear question that ends with a question mark: answer almost at once. */
  question: 450,
  /** A finished sentence that asks for something. */
  statement: 900,
  /** A very short finished sentence, or text with no punctuation at all. */
  uncertain: 1_600,
  /** The speaker stopped in the middle of a sentence. */
  incomplete: 2_300,
  /** A story or situation was described but the actual question has not come yet. */
  setup: 3_200,
  /** Once the question has been growing this long, stop waiting for more. */
  maximumHold: 15_000,
  /** Once the question is this long, stop waiting for more. */
  maximumCharacters: 1_800,
} as const;

const sentences = (text: string): string[] => text.split(/(?<=[.!?])\s+/).map((part) => part.trim()).filter(Boolean);
const asks = (sentence: string): boolean => sentence.includes('?') || QUESTION_START.test(sentence) || ASK_PHRASE.test(sentence);

/** How long to wait for the speaker to carry on before the question is sent to the AI. */
export function questionGraceMs(text: string, heldMs = 0): number {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return 0;
  if (clean.length >= ASSEMBLER_TIMING.maximumCharacters) return 250;
  const pastLimit = heldMs >= ASSEMBLER_TIMING.maximumHold;
  const cap = (ms: number): number => (pastLimit ? Math.min(ms, 300) : ms);
  const words = clean.split(' ').length;
  const last = sentences(clean).at(-1) ?? clean;
  if (/\?["')\]]*$/.test(clean)) return cap(ASSEMBLER_TIMING.question);
  // A full stop or exclamation mark means the sentence was finished; a comma, dots or nothing means it was not.
  const finished = /[.!]["')\]]*$/.test(clean);
  if (!finished && INCOMPLETE_TAIL.test(clean.replace(/[.…]+$/, ''))) return cap(ASSEMBLER_TIMING.incomplete);
  // "Imagine a service with a million users." is the situation, not yet the question.
  if (SCENARIO_CUE.test(clean) && !asks(last)) return cap(ASSEMBLER_TIMING.setup);
  if (finished) return cap(words >= 5 || asks(last) ? ASSEMBLER_TIMING.statement : ASSEMBLER_TIMING.uncertain);
  return cap(asks(last) && words >= 6 ? ASSEMBLER_TIMING.statement + 200 : ASSEMBLER_TIMING.uncertain + 200);
}

interface Options {
  /** Called once the speaker has stayed quiet long enough. */
  ready(question: string): void;
  now?(): number;
  schedule?(callback: () => void, ms: number): unknown;
  cancel?(handle: unknown): void;
}

/**
 * Joins the pieces of one spoken question. Interviewers often pause in the middle of a long or scenario-based
 * question; each pause ends a speech turn. Instead of answering the first piece, the text is kept, and the AI
 * is asked only after the speaker has stayed quiet for a time that depends on how finished the question sounds.
 */
export class AutoQuestionAssembler {
  private text = '';
  private startedAt = 0;
  private handle: unknown;
  private readonly now: () => number;
  private readonly schedule: (callback: () => void, ms: number) => unknown;
  private readonly cancel: (handle: unknown) => void;

  constructor(private readonly options: Options) {
    this.now = options.now ?? (() => Date.now());
    this.schedule = options.schedule ?? ((callback, ms) => setTimeout(callback, ms));
    this.cancel = options.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  /** The question collected so far. */
  get pending(): string { return this.text; }
  get waiting(): boolean { return this.handle !== undefined; }

  /** Speech is flowing again: keep what was said and stop the countdown. */
  hold(): void { this.clearTimer(); }

  /** A speech turn ended. Returns the question collected so far. */
  turnEnded(text: string): string {
    const incoming = text.trim();
    if (!incoming && !this.text) return '';
    if (!this.text) this.startedAt = this.now();
    this.text = mergeFinalTranscriptText(this.text, incoming);
    this.clearTimer();
    this.handle = this.schedule(() => this.fire(), questionGraceMs(this.text, this.now() - this.startedAt));
    return this.text;
  }

  /** Forget everything collected, for example after Clear or when the mode changes. */
  discard(): void { this.clearTimer(); this.text = ''; this.startedAt = 0; }

  private fire(): void {
    this.handle = undefined;
    const question = this.text;
    this.text = '';
    this.startedAt = 0;
    if (question.trim()) this.options.ready(question);
  }

  private clearTimer(): void {
    if (this.handle !== undefined) this.cancel(this.handle);
    this.handle = undefined;
  }
}
