import { afterEach, describe, expect, it, vi } from 'vitest';
import { EyeContactScroll, type ReadingState } from '../src/renderer/services/eyeContactScroll';

const state: ReadingState = { enabled: true, hidden: false, turn: 1, questionId: 'a', hasAnswer: true, pendingQuestion: false, speaking: false, submitting: false, word: 0 };
function fixture(roundPixels = false) {
  let counter = 0, time = 0, bodyHeight = 200, resize = () => {}, visibility = () => {};
  const frames = new Map<number, FrameRequestCallback>();
  const steps: number[] = [];
  const doc = { hidden: false, addEventListener: (_: string, cb: () => void) => { visibility = cb; }, removeEventListener: vi.fn() };
  const disconnect = vi.fn();
  vi.stubGlobal('document', doc);
  vi.stubGlobal('ResizeObserver', class { constructor(cb: () => void) { resize = cb; } observe() {} disconnect = disconnect; });
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.set(++counter, cb); return counter; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.stubGlobal('getComputedStyle', () => ({ lineHeight: '24px', fontSize: '16px' }));
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  const content = { style: { paddingBottom: '', minHeight: '' }, querySelector: (selector: string) => ({ getBoundingClientRect: () => ({ top: 100 + (selector === '.question-row' ? 10 : 120 + Math.floor(Math.max(0, Number(selector.match(/index="(\d+)/)?.[1] ?? 0)) / 4) * 24) - panel.scrollTop }) }) };
  const panel = { scrollTop: 0, clientHeight: 400, get scrollHeight() { return bodyHeight + (parseFloat(content.style.paddingBottom) || 0); },
    getBoundingClientRect: () => ({ top: 100 }), scrollTo: ({ top }: { top: number }) => { steps.push(top - panel.scrollTop); panel.scrollTop = roundPixels ? Math.round(top) : top; } };
  const controller = new EyeContactScroll(panel as unknown as HTMLElement, content as unknown as HTMLElement);
  const tick = () => { const callbacks = [...frames.values()]; frames.clear(); time += 16; callbacks.forEach(cb => cb(time)); };
  const drain = () => { for (let i = 0; frames.size && i < 1000; i++) tick(); expect(frames.size).toBe(0); };
  return { controller, panel, content, steps, frames, tick, drain, long: () => { bodyHeight = 2000; }, resize: () => resize(), doc, visibility: () => visibility(), disconnect };
}
afterEach(() => vi.unstubAllGlobals());
describe('eye-contact DOM controller', () => {
  it('aligns the first short answer on the first frame without waiting for overflow or animation', () => {
    const f = fixture(); expect(f.panel.scrollHeight).toBeLessThan(f.panel.clientHeight);
    f.controller.update(state);
    for (let i = 0; i < 100; i++) f.resize();
    expect(f.frames.size).toBe(1); f.tick();
    expect(120 - f.panel.scrollTop).toBeCloseTo(2.4);
    expect(f.frames.size).toBe(0);
    expect(f.content.style.paddingBottom).not.toBe('');
    f.controller.dispose(); expect(f.disconnect).toHaveBeenCalledOnce();
  });
  it('waits for readable text, then immediately aligns each new answer', () => {
    const f = fixture();
    f.controller.update({ ...state, hasAnswer: false }); f.drain(); expect(f.steps).toEqual([]);
    f.controller.update(state); f.tick(); expect(120 - f.panel.scrollTop).toBeCloseTo(2.4);
    f.long(); f.controller.update({ ...state, word: 100 }); f.drain();
    f.controller.update({ ...state, questionId: 'b', hasAnswer: false, word: -1 }); f.drain();
    f.controller.update({ ...state, questionId: 'b' }); f.tick();
    expect(120 - f.panel.scrollTop).toBeCloseTo(2.4); f.controller.dispose();
  });
  it('ignores same-line words and streamed layout callbacks, follows newer voice targets without waiting for stale motion', () => {
    const f = fixture(); f.long(); f.controller.update(state); f.drain(); f.steps.length = 0;
    for (let word = 1; word < 4; word++) { f.controller.update({ ...state, word }); f.resize(); f.drain(); }
    expect(f.steps).toEqual([]);
    f.controller.update({ ...state, word: 4 }); f.drain();
    expect(144 - f.panel.scrollTop).toBeCloseTo(2.4, 0);
    expect(f.steps.every(step => Math.abs(step) <= 24)).toBe(true);
    f.controller.update({ ...state, word: 80 }); f.tick(); f.tick();
    f.controller.update({ ...state, word: 120 }); f.tick(); f.drain();
    expect(840 - f.panel.scrollTop).toBeCloseTo(2.4, 0);
    expect(f.steps.every(step => Math.abs(step) <= 24)).toBe(true);
    f.steps.length = 0; f.resize(); f.drain(); expect(f.steps).toEqual([]); f.controller.dispose();
  });
  it('interrupts old answer following immediately for a question and never follows its old word index', () => {
    const f = fixture(); f.controller.update(state); f.drain();
    f.controller.update({ ...state, word: 40 }); f.tick();
    f.controller.update({ ...state, turn: 2, pendingQuestion: true, speaking: true, word: 40 }); f.drain();
    expect(f.panel.scrollTop).toBeLessThan(10);
    f.controller.update({ ...state, turn: 2, pendingQuestion: true, word: 50 }); f.drain();
    expect(f.panel.scrollTop).toBeLessThan(10); f.controller.dispose();
  });
  it('OFF cancels queued movement and preserves exact manual position across streaming/resize; ON resumes', () => {
    const f = fixture(); f.controller.update(state); f.tick();
    f.controller.update({ ...state, enabled: false }); f.panel.scrollTop = 53;
    for (let i = 0; i < 50; i++) { f.resize(); f.controller.update({ ...state, enabled: false, word: i }); }
    f.drain(); expect(f.panel.scrollTop).toBe(53);
    f.controller.update(state); f.drain(); expect(f.panel.scrollTop).toBeGreaterThan(90); f.controller.dispose();
  });
  it('suspends hidden work and cleans animation/observation on collapse disposal', () => {
    const f = fixture(); f.controller.update(state); f.doc.hidden = true; f.visibility();
    expect(f.frames.size).toBe(0); f.resize(); expect(f.frames.size).toBe(0);
    f.doc.hidden = false; f.visibility(); f.drain(); expect(f.panel.scrollTop).toBeGreaterThan(90);
    f.controller.update({ ...state, word: 50 }); f.controller.dispose(); expect(f.frames.size).toBe(0);
  });
  it('settles without an idle animation loop when Windows zoom rounds fractional scroll positions', () => {
    const f = fixture(true); f.long(); f.controller.update(state); f.drain();
    f.controller.update({ ...state, word: 12 }); f.drain();
    expect(Math.abs(f.panel.scrollTop - (192 - 2.4))).toBeLessThan(1);
    expect(f.frames.size).toBe(0); f.controller.dispose();
  });
});

describe('with Auto Scroll off', () => {
  const off: ReadingState = { ...state, enabled: false };
  it('still brings a new question to the top, wherever the answer was being read, and moves nothing else', () => {
    const f = fixture(); f.long();
    f.controller.update(off);                               // the first state only sets things up
    f.panel.scrollTop = 500;
    f.controller.update({ ...off, word: 50 }); f.controller.update({ ...off, hasAnswer: false }); f.controller.update({ ...off, questionId: 'b' }); f.drain();
    expect(f.panel.scrollTop).toBe(500);                    // reading progress and new answers never move the page
    f.controller.update({ ...off, turn: 2 });               // the interviewer starts a new question
    expect(f.panel.scrollTop).toBeCloseTo(7.6);
    expect(f.frames.size).toBe(0);                          // no animation is left running
    f.panel.scrollTop = 900; f.controller.update({ ...off, turn: 2, pendingQuestion: true, speaking: true });
    expect(f.panel.scrollTop).toBe(900);                    // the same question being spoken does not keep pulling the page
    f.controller.dispose();
  });
  it('keeps the room at the end of the answer, so the last two lines stay on screen and no empty page is reachable', () => {
    const f = fixture(); f.long();
    f.controller.update(off);
    // 400 high, minus the first-line inset (2.4), minus two lines and a little extra (24 * 2.6)
    expect(parseFloat(f.content.style.paddingBottom)).toBeCloseTo(400 - 2.4 - 24 * 2.6, 1);
    const maximum = f.panel.scrollHeight - f.panel.clientHeight;
    expect(maximum).toBeCloseTo(2000 + 335.2 - 400, 0);
    f.controller.dispose();
  });
  it('does not scroll for a new question while the window is hidden', () => {
    const f = fixture(); f.long();
    f.controller.update({ ...off, hidden: true }); f.panel.scrollTop = 500;
    f.controller.update({ ...off, hidden: true, turn: 2 });
    expect(f.panel.scrollTop).toBe(500);
    f.controller.dispose();
  });
});

