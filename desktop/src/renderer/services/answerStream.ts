/** The first line of an answer is shown the moment any text arrives. */
const FIRST_LINE_CHARS = 90;
/** Up to this much waiting text is simply shown on the next frame, as tokens arrive. */
const SMALL_BACKLOG_CHARS = 60;
/** A large piece (some models send a whole answer at once) is shown line by line, finished within this time. */
const REVEAL_MS = 320;
const FRAME_MS = 16;

/** The end of the word that contains or follows `from`: a piece never ends in the middle of a word it already has. */
function wordEnd(text: string, from: number): number {
  const space = text.slice(Math.min(from, text.length)).search(/\s/);
  return space < 0 ? text.length : Math.min(from, text.length) + space;
}

/**
 * First useful text is delivered synchronously; later small pieces render once per frame. A large piece does not
 * flash onto the screen: its first line is shown at once and the rest follows line by line within a fraction of a
 * second, far faster than anyone reads, so nothing is held back.
 */
export class AnswerStream {
  private id: string | null = null;
  private pending = '';
  private visible = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private deadline = 0;
  private completion: (() => void) | null = null;
  constructor(private readonly append: (text: string) => void, private readonly now: () => number = () => Date.now()) {}
  start(id: string): void {
    // An answer that was still being shown when the next one begins is finished first.
    const waiting = this.completion;
    this.dispose();
    this.id = id; this.visible = false;
    waiting?.();
  }
  push(id: string, text: string): void {
    if (id !== this.id) return;
    this.pending += text;
    if (!this.visible) {
      if (!this.pending.trim()) return;
      this.visible = true;
      this.show(this.pending.length <= FIRST_LINE_CHARS ? this.pending.length : wordEnd(this.pending, FIRST_LINE_CHARS));
    }
    if (!this.pending) return;
    if (this.pending.length > SMALL_BACKLOG_CHARS) this.deadline = this.now() + REVEAL_MS;
    if (!this.timer) this.timer = setTimeout(this.frame, FRAME_MS);
  }
  /** The answer is complete: whatever is still being shown finishes first, then `done` runs (at once when nothing waits). */
  complete(id: string, done: () => void): void {
    if (id !== this.id) return;
    if (!this.timer) { this.dispose(); done(); return; }
    this.completion = done;
  }
  accepts(id: string): boolean { return id === this.id; }
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.show(this.pending.length);
  }
  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null; this.pending = ''; this.id = null; this.deadline = 0; this.completion = null;
  }
  private show(length: number): void {
    const text = this.pending.slice(0, length);
    this.pending = this.pending.slice(length);
    if (text) this.append(text);
  }
  private frame = (): void => {
    this.timer = null;
    const now = this.now();
    if (this.pending.length <= SMALL_BACKLOG_CHARS || now >= this.deadline) this.show(this.pending.length);
    else {
      // Spread what is waiting evenly over the time that is left.
      const frames = Math.max(1, Math.ceil((this.deadline - now) / FRAME_MS));
      this.show(wordEnd(this.pending, Math.ceil(this.pending.length / frames)));
    }
    if (this.pending) { this.timer = setTimeout(this.frame, FRAME_MS); return; }
    const done = this.completion;
    if (done) { this.dispose(); done(); }
  };
}
