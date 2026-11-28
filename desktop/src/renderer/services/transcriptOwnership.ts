import type { TranscriptEvent } from '../../shared/types';
import { afterWords } from './liveTalk';

/** The customer takes the box over once the interviewer has been quiet this long. */
export const INTERVIEWER_OWNERSHIP_GRACE_MS = 700;
const CANDIDATE_MIN_CONFIDENCE = 0.45;
/** For this long after the interviewer spoke, hearing the same words on the microphone may be the speakers. */
const ECHO_WINDOW_MS = 4_000;
/** The speakers heard on the microphone give nearly the same words in the same order; the customer repeating part of
 * a question adds their own words ("So the event loop..."), which stays below this. */
const ECHO_SHARE = 0.8;
/** Only the interviewer's latest words are compared. */
const ECHO_WORDS = 80;

/** Words compared without case, punctuation or a plural "s" (speech services differ on these). */
const spokenWords = (text: string): string[] => (text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [])
  .map((word) => word.replace(/'/g, '')).map((word) => (word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word)).filter(Boolean);

/** How many of `said` appear in `heard` in the same order. */
function inOrder(said: string[], heard: string[]): number {
  const row = new Array<number>(heard.length + 1).fill(0);
  for (const word of said) {
    let diagonal = 0;
    for (let j = 1; j <= heard.length; j += 1) {
      const above = row[j];
      row[j] = word === heard[j - 1] ? diagonal + 1 : Math.max(row[j], row[j - 1]);
      diagonal = above;
    }
  }
  return row[heard.length];
}

/** The share of `said` found in order and close together somewhere in `heard`. */
function echoShare(said: string[], heard: string[]): number {
  const span = Math.ceil(said.length * 1.3) + 1;
  let best = 0;
  for (let start = 0; start < heard.length && best < said.length; start += 1) {
    best = Math.max(best, inOrder(said, heard.slice(start, start + span)));
  }
  return best / said.length;
}

function meaningfulCandidateSpeech(event: TranscriptEvent): boolean {
  const words = event.text.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (event.confidence < CANDIDATE_MIN_CONFIDENCE) return false;
  return words.length >= 2 || (event.isFinal && words.some((word) => word.length >= 4) && event.confidence >= 0.8);
}

/**
 * Decides only which stream may own the shared transcript UI. Both streams are
 * still ingested and persisted independently. Interviewer activity wins
 * immediately; candidate text must be meaningful, arrive after a short quiet
 * gap, and not be the microphone picking up the interviewer from the speakers.
 */
export class TranscriptOwnership {
  private lastInterviewerActivity = Number.NEGATIVE_INFINITY;
  /** The interviewer's recent sentences, each with when it was last heard. */
  private interviewerTurns: { text: string; at: number }[] = [];

  constructor(
    private readonly graceMs = INTERVIEWER_OWNERSHIP_GRACE_MS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Nearly the same words the interviewer just said: the microphone is hearing the speakers. */
  isEcho(event: TranscriptEvent): boolean {
    if (event.sourceRole !== 'local_candidate') return false;
    const at = this.now();
    if (at - this.lastInterviewerActivity > ECHO_WINDOW_MS) return false;
    const said = spokenWords(event.text).slice(-30);
    if (!said.length) return false;
    const heard = spokenWords(this.interviewerTurns.filter((turn) => at - turn.at <= 2 * ECHO_WINDOW_MS)
      .map((turn) => turn.text).join(' ')).slice(-ECHO_WORDS);
    return echoShare(said, heard) >= ECHO_SHARE;
  }

  shouldClaim(event: TranscriptEvent): boolean {
    const receivedAt = this.now();
    if (event.sourceRole === 'remote_interviewer') {
      if (!event.text.trim()) return false;
      this.lastInterviewerActivity = receivedAt;
      this.rememberInterviewer(event.text, receivedAt);
      return true;
    }
    if (event.sourceRole !== 'local_candidate' || !meaningfulCandidateSpeech(event) || this.isEcho(event)) return false;
    return receivedAt - this.lastInterviewerActivity >= this.graceMs;
  }

  candidateClaimDelay(event: TranscriptEvent): number | null {
    if (event.sourceRole !== 'local_candidate' || !meaningfulCandidateSpeech(event) || this.isEcho(event)) return null;
    return Math.max(0, this.graceMs - (this.now() - this.lastInterviewerActivity));
  }

  reset(): void {
    this.lastInterviewerActivity = Number.NEGATIVE_INFINITY;
    this.interviewerTurns = [];
  }

  /** Each update repeats the sentence so far, so it replaces the one it continues. Only a few are kept. */
  private rememberInterviewer(text: string, at: number): void {
    const last = this.interviewerTurns.at(-1);
    if (last && afterWords(text, last.text) !== null) { last.text = text; last.at = at; return; }
    this.interviewerTurns = [...this.interviewerTurns.slice(-3), { text, at }];
  }
}
