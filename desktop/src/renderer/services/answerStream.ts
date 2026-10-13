/** First useful text is delivered synchronously; later bursts render once per frame interval. */
export class AnswerStream {
  private id: string | null = null;
  private pending = '';
  private visible = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(private readonly append: (text: string) => void) {}
  start(id: string): void { this.dispose(); this.id = id; this.visible = false; }
  push(id: string, text: string): void {
    if (id !== this.id) return;
    this.pending += text;
    if (!this.visible) {
      if (!this.pending.trim()) return;
      this.visible = true;
      this.flush();
    } else if (!this.timer) this.timer = setTimeout(() => this.flush(), 16);
  }
  accepts(id: string): boolean { return id === this.id; }
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const text = this.pending;
    this.pending = '';
    if (text) this.append(text);
  }
  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null; this.pending = ''; this.id = null;
  }
}
