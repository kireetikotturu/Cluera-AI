// Local editor ownership, keyed by the existing transcript-store turn sequence.
// It holds no transcript copies and adds no subscriptions/timers.
export class ManualQuestionOwnership {
  private turn: number | null = null;
  private revision = 0;
  private consumedTurn: number | null = null;
  edited = false;

  observe(turn: number, active: boolean): { startsNewTurn: boolean; acceptTranscript: boolean } {
    const startsNewTurn = active && turn !== this.turn;
    if (startsNewTurn) {
      this.turn = turn;
      this.edited = false;
      this.consumedTurn = null;
      this.revision += 1;
    }
    return { startsNewTurn, acceptTranscript: !this.edited && (!active || turn !== this.consumedTurn) };
  }

  edit(turn: number): void {
    this.turn = turn;
    this.edited = true;
    this.revision += 1;
  }

  snapshot(turn: number): { turn: number; revision: number } {
    return { turn, revision: this.revision };
  }

  isCurrent(sent: { turn: number; revision: number }, currentTurn: number): boolean {
    return sent.turn === currentTurn && sent.revision === this.revision;
  }

  finish(sent: { turn: number; revision: number }, currentTurn: number): boolean {
    // A slow request must not clear newer speech or edits made while awaiting IPC.
    if (!this.isCurrent(sent, currentTurn)) return false;
    this.turn = currentTurn;
    this.edited = false;
    this.consumedTurn = currentTurn;
    return true;
  }

  reset(): void {
    this.turn = null;
    this.edited = false;
    this.consumedTurn = null;
    this.revision += 1;
  }
}
