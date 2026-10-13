export type TurnDecision = 'ANSWER_NOW' | 'WAIT' | 'IGNORE';

export class TurnGate {
  private transcript = '';

  update(text: string, event: 'partial' | 'end' | 'resume'): { decision: TurnDecision; transcript: string } {
    this.transcript = text.trim() || this.transcript;
    if (event === 'resume') return { decision: 'WAIT', transcript: this.transcript };
    if (event === 'partial') return { decision: 'WAIT', transcript: this.transcript };
    const completed = this.transcript;
    this.transcript = '';
    if (!completed || completed.split(/\s+/).length < 2) return { decision: 'IGNORE', transcript: completed };
    return { decision: 'ANSWER_NOW', transcript: completed };
  }

  reset(): void { this.transcript = ''; }
}
