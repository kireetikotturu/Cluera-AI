import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnswerStream } from '../src/renderer/services/answerStream';

afterEach(() => vi.useRealTimers());
describe('renderer incremental answers', () => {
  it('shows the first useful chunk without waiting for a timer or completion', () => {
    vi.useFakeTimers();
    const append = vi.fn(); const stream = new AnswerStream(append);
    stream.start('a'); stream.push('a', ' '); expect(append).not.toHaveBeenCalled();
    stream.push('a', 'The issue is');
    expect(append).toHaveBeenCalledWith(' The issue is');
    stream.push('a', ' caused by'); stream.push('a', ' the dependency.');
    expect(append).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(16);
    expect(append).toHaveBeenLastCalledWith(' caused by the dependency.');
    stream.dispose();
  });
  it('ignores stale tokens and pending updates from a replaced answer', () => {
    vi.useFakeTimers(); const append = vi.fn(); const stream = new AnswerStream(append);
    stream.start('old'); stream.push('old', 'Old'); stream.push('old', ' queued');
    stream.start('new'); stream.push('old', ' late'); stream.push('new', 'New');
    vi.runAllTimers();
    expect(append.mock.calls.map(call => call[0])).toEqual(['Old', 'New']);
    expect(stream.accepts('old')).toBe(false);
    stream.dispose();
  });

  const words = (count: number): string => Array.from({ length: count }, (_, index) => `word${index}`).join(' ');

  it('shows the first line of a large piece at once and the rest line by line, never in the middle of a word', () => {
    vi.useFakeTimers();
    const append = vi.fn(); const stream = new AnswerStream(append);
    const answer = words(100);
    stream.start('a'); stream.push('a', answer);
    // Nothing waits for a timer: the first line is already on screen.
    expect(append).toHaveBeenCalledTimes(1);
    const first = append.mock.calls[0][0] as string;
    expect(first.length).toBeGreaterThanOrEqual(90);
    expect(first.length).toBeLessThan(110);
    expect(answer.startsWith(first)).toBe(true);
    expect(/\s/.test(answer[first.length] ?? ' ')).toBe(true);
    vi.advanceTimersByTime(16 * 8);
    expect(append.mock.calls.length).toBeGreaterThan(4); // arrives in steps, not in one flash
    vi.advanceTimersByTime(400);
    const shown = append.mock.calls.map(call => call[0]).join('');
    expect(shown).toBe(answer);
    // Every piece after the first starts at a space: no word is ever cut in two.
    for (const [piece] of append.mock.calls.slice(1)) expect(piece).toMatch(/^\s/);
    stream.dispose();
  });

  it('shows even a very large piece completely within the reveal time', () => {
    vi.useFakeTimers();
    const append = vi.fn(); const stream = new AnswerStream(append);
    const answer = words(600);
    stream.start('a'); stream.push('a', answer);
    vi.advanceTimersByTime(340);
    expect(append.mock.calls.map(call => call[0]).join('')).toBe(answer);
    stream.dispose();
  });

  it('keeps showing small tokens as they arrive without pacing them', () => {
    vi.useFakeTimers();
    const append = vi.fn(); const stream = new AnswerStream(append);
    stream.start('a');
    stream.push('a', 'Hello');
    for (const token of [' there', ' and', ' welcome']) { stream.push('a', token); vi.advanceTimersByTime(16); }
    expect(append.mock.calls.map(call => call[0])).toEqual(['Hello', ' there', ' and', ' welcome']);
    stream.dispose();
  });

  it('runs the completion only after the last piece is shown, and at once when nothing waits', () => {
    vi.useFakeTimers();
    const append = vi.fn(); const stream = new AnswerStream(append);
    const done = vi.fn();
    stream.start('a'); stream.push('a', words(100));
    stream.complete('a', done);
    expect(done).not.toHaveBeenCalled();
    vi.advanceTimersByTime(400);
    expect(done).toHaveBeenCalledTimes(1);
    expect(append.mock.calls.map(call => call[0]).join('')).toBe(words(100));
    expect(stream.accepts('a')).toBe(false);

    const immediate = vi.fn();
    stream.start('b'); stream.push('b', 'Short'); stream.complete('b', immediate);
    expect(immediate).toHaveBeenCalledTimes(1);
    const unseen = vi.fn();
    stream.start('c'); stream.complete('c', unseen);
    expect(unseen).toHaveBeenCalledTimes(1);
    stream.dispose();
  });

  it('finishes the previous answer first when the next one starts while it is still being shown', () => {
    vi.useFakeTimers();
    const append = vi.fn(); const stream = new AnswerStream(append);
    const order: string[] = [];
    stream.start('old'); stream.push('old', words(100));
    stream.complete('old', () => order.push('old finished'));
    stream.start('new'); order.push('new started');
    expect(order).toEqual(['old finished', 'new started']);
    stream.push('new', 'Fresh');
    expect(stream.accepts('new')).toBe(true);
    stream.dispose();
  });

  it('ignores a completion for an answer that is no longer the current one', () => {
    const stream = new AnswerStream(() => undefined);
    const done = vi.fn();
    stream.start('a'); stream.complete('other', done);
    expect(done).not.toHaveBeenCalled();
    stream.dispose();
  });
});
