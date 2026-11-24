/**
 * The speech service repeats the whole turn so far in every update. When the customer presses Clear while the
 * speaker is still talking, the next update would bring the cleared words straight back. This filter remembers
 * how much of the turn was cleared and hides exactly that part until the turn ends.
 */
const normalizeWord = (word: string): string => word.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const words = (text: string): string[] => text.split(/\s+/).map(normalizeWord).filter(Boolean);

/** The original text without its first `count` spoken words, keeping capitalisation and punctuation. */
function dropWords(text: string, count: number): string {
  const raw = text.trim().split(/\s+/).filter(Boolean);
  let seen = 0;
  let index = 0;
  while (index < raw.length && seen < count) { if (normalizeWord(raw[index])) seen += 1; index += 1; }
  return raw.slice(index).join(' ');
}

export class TurnPrefixFilter {
  private cleared: string[] = [];
  private latest = '';

  /** Returns the part of this update the customer has not cleared. Empty when nothing new was said. */
  observe(text: string): string {
    this.latest = text;
    if (!this.cleared.length) return text;
    const incoming = words(text);
    const compared = Math.min(this.cleared.length, incoming.length);
    let same = 0;
    for (let index = 0; index < compared; index += 1) if (incoming[index] === this.cleared[index]) same += 1;
    // The speech service sometimes corrects an earlier word, so allow a small mismatch. A different text is a new turn.
    const matches = compared > 0 && same >= Math.ceil(compared * 0.8);
    if (!matches) { this.cleared = []; return text; }
    return dropWords(text, this.cleared.length);
  }

  /** The customer cleared everything captured so far in this turn. */
  discard(): void { this.cleared = words(this.latest); }

  /** The speaker's turn is over; the next turn starts from nothing. */
  endTurn(): void { this.cleared = []; this.latest = ''; }

  get hasDiscarded(): boolean { return this.cleared.length > 0; }
}
