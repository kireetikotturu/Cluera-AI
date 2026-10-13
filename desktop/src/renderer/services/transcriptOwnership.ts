import type { TranscriptEvent } from '../../shared/types';

export const INTERVIEWER_OWNERSHIP_GRACE_MS = 1_500;
const CANDIDATE_MIN_CONFIDENCE = 0.45;

function meaningfulCandidateSpeech(event: TranscriptEvent): boolean {
  const words = event.text.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (event.confidence < CANDIDATE_MIN_CONFIDENCE) return false;
  return words.length >= 2 || (event.isFinal && words.some((word) => word.length >= 4) && event.confidence >= 0.8);
}

/**
 * Decides only which stream may own the shared transcript UI. Both streams are
 * still ingested and persisted independently. Interviewer activity wins
 * immediately; candidate text must be meaningful and arrive after a quiet
 * grace period to prevent microphone noise from causing speaker flicker.
 */
export class TranscriptOwnership {
  private lastInterviewerActivity = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly graceMs = INTERVIEWER_OWNERSHIP_GRACE_MS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  shouldClaim(event: TranscriptEvent): boolean {
    const receivedAt = this.now();
    if (event.sourceRole === 'remote_interviewer') {
      if (event.text.trim()) this.lastInterviewerActivity = receivedAt;
      return Boolean(event.text.trim());
    }
    if (event.sourceRole !== 'local_candidate' || !meaningfulCandidateSpeech(event)) return false;
    return receivedAt - this.lastInterviewerActivity >= this.graceMs;
  }

  candidateClaimDelay(event: TranscriptEvent): number | null {
    if (event.sourceRole !== 'local_candidate' || !meaningfulCandidateSpeech(event)) return null;
    return Math.max(0, this.graceMs - (this.now() - this.lastInterviewerActivity));
  }

  reset(): void {
    this.lastInterviewerActivity = Number.NEGATIVE_INFINITY;
  }
}
