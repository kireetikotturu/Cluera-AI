/** Joins two pieces of one spoken question, removing words the speech service repeated at the seam. */
export function mergeFinalTranscriptText(current: string, incoming: string): string {
  const previous = current.trim().replace(/\s+/g, ' ');
  const next = incoming.trim().replace(/\s+/g, ' ');
  if (!previous) return next;
  if (!next || previous === next || previous.endsWith(next)) return previous;
  if (next.startsWith(previous)) return next;
  const previousWords = previous.split(' ');
  const nextWords = next.split(' ');
  const maximumOverlap = Math.min(12, previousWords.length, nextWords.length);
  for (let size = maximumOverlap; size > 0; size -= 1) {
    if (previousWords.slice(-size).join(' ').toLowerCase() === nextWords.slice(0, size).join(' ').toLowerCase()) {
      return [...previousWords, ...nextWords.slice(size)].join(' ');
    }
  }
  return `${previous} ${next}`;
}
