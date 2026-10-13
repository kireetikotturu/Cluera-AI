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
});
