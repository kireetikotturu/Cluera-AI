import { readingLineTopOffset, renderedAnswerLineHeight } from './answerScroll';

export interface ReadingState {
  enabled: boolean; hidden: boolean; turn: number; questionId?: string;
  hasAnswer: boolean; pendingQuestion: boolean; speaking: boolean; submitting: boolean; word: number;
}

/** Pure priority/ownership model; no timers, transcripts or history retained. */
export class ReadingFocus {
  mode: 'question' | 'answer' = 'question';
  private previous: ReadingState | null = null;
  private blockedAnswer: string | undefined;
  private answeredTurn = -1;
  private heldAt: number | null = null;
  private selectedAt: number | null = null;
  word = 0;

  hold(word: number): void { this.heldAt = word; }
  update(next: ReadingState): boolean {
    const previous = this.previous;
    this.previous = next;
    const newTurn = previous !== null && next.turn !== previous.turn;
    const submitted = next.submitting && !previous?.submitting;
    const newAnswer = Boolean(next.questionId && next.questionId !== previous?.questionId);
    if (previous && newAnswer) this.selectedAt = next.word;
    if (this.selectedAt !== null && next.word > this.selectedAt) this.selectedAt = null;
    this.word = this.selectedAt === null ? Math.max(0, next.word) : 0;
    if (newTurn || submitted || (next.pendingQuestion && this.answeredTurn !== next.turn)) {
      this.mode = 'question';
      this.blockedAnswer = next.questionId;
      if (newTurn || submitted) this.heldAt = null;
    } else if (newAnswer || (next.hasAnswer && next.questionId !== this.blockedAnswer)) {
      this.mode = 'answer';
      if (newAnswer) { this.heldAt = null; this.blockedAnswer = undefined; }
    }
    // A new answer belongs to the submitted turn, even if an old pending UI
    // value has not cleared yet. Actual new interviewer speech still wins.
    if (newAnswer && !newTurn && !next.speaking && (previous !== null || !next.pendingQuestion)) {
      this.mode = 'answer'; this.answeredTurn = next.turn; this.blockedAnswer = undefined;
    }
    if (!next.enabled || next.hidden) return false;
    if (!previous?.enabled || previous.hidden) this.heldAt = null;
    if (this.heldAt !== null) {
      if (next.word <= this.heldAt) return false;
      this.heldAt = null;
    }
    return true;
  }
}

/** One event-driven controller/RAF owner for both question and answer anchors. */
export class EyeContactScroll {
  private state: ReadingState | null = null;
  private frame = 0;
  private target = 0;
  private lastTime = 0;
  private disposed = false;
  private remeasure = false;
  private alignImmediately = true;
  private readonly observer: ResizeObserver;

  constructor(private readonly panel: HTMLElement, private readonly content: HTMLElement, private readonly focus = new ReadingFocus()) {
    this.observer = new ResizeObserver(() => this.schedule());
    this.observer.observe(panel); this.observer.observe(content);
    document.addEventListener('visibilitychange', this.visibility);
  }
  private visibility = (): void => { this.cancel(); if (!document.hidden) this.schedule(); };
  update(state: ReadingState): void {
    const previous = this.state;
    const previousMode = this.focus.mode;
    this.state = state;
    this.focus.update(state);
    if (!previous?.enabled || previous.hidden || state.questionId !== previous.questionId
      || (state.hasAnswer && !previous.hasAnswer) || this.focus.mode !== previousMode) this.alignImmediately = true;
    if (!state.enabled || state.hidden) { this.cancel(); return; }
    if (state.turn !== previous?.turn || state.questionId !== previous?.questionId
      || state.pendingQuestion !== previous?.pendingQuestion || state.submitting !== previous?.submitting) this.cancel();
    this.schedule();
  }
  hold(): void { this.focus.hold(this.state?.word ?? -1); this.cancel(); }
  private cancel(): void { cancelAnimationFrame(this.frame); this.frame = 0; this.lastTime = 0; this.remeasure = false; }
  private schedule(): void {
    if (this.disposed || !this.state?.enabled || this.state.hidden || document.hidden) return;
    if (this.frame) { this.remeasure = true; return; }
    this.remeasure = false;
    this.frame = requestAnimationFrame(() => { this.frame = 0; this.measure(); });
  }
  private measure(): void {
    const state = this.state;
    if (!state || !this.focus.update(state)) return;
    const rich = this.content.querySelector<HTMLElement>('.answer-rich');
    const line = renderedAnswerLineHeight(getComputedStyle(rich ?? this.content));
    const inset = readingLineTopOffset(line);
    // Padding, not a visible placeholder block, gives short answers positioning
    // room. It is retained/frozen when OFF so the manual viewport cannot clamp.
    const padding = `${Math.max(0, this.panel.clientHeight - inset - line)}px`;
    if (this.content.style.paddingBottom !== padding) this.content.style.paddingBottom = padding;
    this.content.style.minHeight = '';
    // Do not consume first-answer alignment on the empty streaming placeholder.
    if (this.focus.mode === 'answer' && !state.hasAnswer) return;
    const anchor = this.focus.mode === 'question' ? this.content.querySelector<HTMLElement>('.question-row')
      : this.content.querySelector<HTMLElement>(`[data-answer-word-index="${this.focus.word}"]`) ?? rich;
    if (!anchor) return;
    this.target = Math.min(Math.max(0, this.panel.scrollHeight - this.panel.clientHeight), Math.max(0, this.panel.scrollTop + anchor.getBoundingClientRect().top - this.panel.getBoundingClientRect().top - inset));
    const immediate = this.alignImmediately || this.focus.mode === 'question';
    this.alignImmediately = false;
    if (Math.abs(this.target - this.panel.scrollTop) < 3) return;
    if (immediate || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      this.panel.scrollTo({ top: this.target, behavior: 'instant' }); return;
    }
    const step = (time: number): void => {
      this.frame = 0;
      if (!this.state?.enabled || this.state.hidden || document.hidden) return;
      // Consume the newest speech/layout target on the next frame, not after
      // finishing a stale journey. No extra loop or token-driven scroll reset.
      if (this.remeasure) { this.remeasure = false; this.measure(); return; }
      // At most one line per frame and ~5 lines/sec; no large native smooth
      // scroll jump. Only runs while travelling to a known reading anchor.
      const delta = Math.min(line, line * Math.min(50, this.lastTime ? time - this.lastTime : 16) / 200);
      this.lastTime = time;
      const distance = this.target - this.panel.scrollTop;
      const before = this.panel.scrollTop;
      this.panel.scrollTo({ top: this.panel.scrollTop + Math.sign(distance) * Math.min(Math.abs(distance), delta), behavior: 'instant' });
      // Native scroll positions may round fractional CSS pixels at some zooms.
      // An unreachable subpixel target must not leave an idle RAF loop alive.
      if (this.panel.scrollTop === before) { this.lastTime = 0; return; }
      if (Math.abs(this.target - this.panel.scrollTop) > .1) this.frame = requestAnimationFrame(step);
      else { this.lastTime = 0; if (this.remeasure) this.schedule(); }
    };
    this.frame = requestAnimationFrame(step);
  }
  dispose(): void { this.disposed = true; this.cancel(); this.observer.disconnect(); document.removeEventListener('visibilitychange', this.visibility); }
}
