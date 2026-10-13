interface WordToken {
  normalized: string;
  end: number;
}

export interface ReadingProgress {
  matchedWords: number;
  totalWords: number;
  currentWordIndex: number;
  characterOffset: number;
  ratio: number;
  confidence: number;
}

function normalizeWord(value: string): string {
  return value.normalize('NFKD').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

function wordsWithOffsets(text: string): WordToken[] {
  return [...text.matchAll(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu)]
    .map((match) => ({ normalized: normalizeWord(match[0]), end: (match.index ?? 0) + match[0].length }))
    .filter((word) => word.normalized.length > 0);
}

function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    let diagonal = previous[0];
    previous[0] = row;
    for (let column = 1; column <= right.length; column += 1) {
      const above = previous[column];
      previous[column] = Math.min(previous[column] + 1, previous[column - 1] + 1,
        diagonal + (left[row - 1] === right[column - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return previous[right.length];
}

function wordMatchScore(left: string, right: string): number {
  if (left === right) return Math.min(left.length, right.length) <= 3 ? 1.5 : 3;
  if (Math.min(left.length, right.length) < 4) return -1.4;
  const distance = editDistance(left, right);
  return distance <= Math.max(1, Math.floor(Math.max(left.length, right.length) * 0.3)) ? 2.1 : -1.4;
}

function retainedProgress(answerWords: WordToken[], previousWordIndex: number): ReadingProgress {
  const currentWordIndex = Math.min(previousWordIndex, answerWords.length - 1);
  return {
    matchedWords: 0,
    totalWords: answerWords.length,
    currentWordIndex,
    characterOffset: currentWordIndex >= 0 ? answerWords[currentWordIndex].end : 0,
    ratio: currentWordIndex >= 0 ? (currentWordIndex + 1) / answerWords.length : 0,
    confidence: 0,
  };
}

/**
 * Local sequence alignment for imperfect speech recognition. It can lock onto
 * a later sentence, tolerates skipped/misheard words, and biases toward forward
 * movement without accepting weak one-word coincidences.
 */
export function estimateReadingProgress(answer: string, spoken: string, previousWordIndex = -1): ReadingProgress {
  const answerWords = wordsWithOffsets(answer);
  const spokenWords = wordsWithOffsets(spoken).slice(-48);
  if (!answerWords.length || !spokenWords.length) return retainedProgress(answerWords, previousWordIndex);

  const width = answerWords.length + 1;
  let previousScores = new Float64Array(width);
  let previousMatches = new Uint16Array(width);
  let previousStrong = new Uint16Array(width);
  let bestScore = 0;
  let bestMetric = Number.NEGATIVE_INFINITY;
  let bestEnd = -1;
  let bestMatches = 0;
  let bestStrong = 0;

  for (const spokenWord of spokenWords) {
    const scores = new Float64Array(width);
    const matches = new Uint16Array(width);
    const strong = new Uint16Array(width);
    for (let column = 1; column < width; column += 1) {
      const answerWord = answerWords[column - 1];
      const matchScore = wordMatchScore(spokenWord.normalized, answerWord.normalized);
      const diagonal = previousScores[column - 1] + matchScore;
      const skipSpoken = previousScores[column] - 0.9;
      const skipAnswer = scores[column - 1] - 0.55;
      let value = 0;
      let source: 'none' | 'diagonal' | 'spoken' | 'answer' = 'none';
      if (diagonal > value) { value = diagonal; source = 'diagonal'; }
      if (skipSpoken > value) { value = skipSpoken; source = 'spoken'; }
      if (skipAnswer > value) { value = skipAnswer; source = 'answer'; }
      scores[column] = value;
      if (source === 'diagonal') {
        matches[column] = previousMatches[column - 1] + (matchScore > 0 ? 1 : 0);
        strong[column] = previousStrong[column - 1] + (matchScore >= 2.1 && Math.max(spokenWord.normalized.length, answerWord.normalized.length) >= 5 ? 1 : 0);
      } else if (source === 'spoken') {
        matches[column] = previousMatches[column];
        strong[column] = previousStrong[column];
      } else if (source === 'answer') {
        matches[column] = matches[column - 1];
        strong[column] = strong[column - 1];
      }

      const end = column - 1;
      const forwardBias = end >= previousWordIndex
        ? Math.min(1.5, Math.max(0, end - previousWordIndex) / Math.max(20, answerWords.length) * 1.5)
        : -Math.min(6, (previousWordIndex - end) * 0.35);
      const metric = value + forwardBias;
      if (metric > bestMetric) {
        bestMetric = metric;
        bestScore = value;
        bestEnd = end;
        bestMatches = matches[column];
        bestStrong = strong[column];
      }
    }
    previousScores = scores;
    previousMatches = matches;
    previousStrong = strong;
  }

  const confidence = bestMatches ? Math.max(0, Math.min(1, bestScore / (bestMatches * 3))) : 0;
  const credible = bestMatches >= 2 && (bestStrong >= 1 || bestMatches >= 4) && bestScore >= 4.2 && confidence >= 0.38;
  if (!credible) return retainedProgress(answerWords, previousWordIndex);

  const currentWordIndex = Math.max(Math.min(previousWordIndex, answerWords.length - 1), bestEnd);
  return {
    matchedWords: bestMatches,
    totalWords: answerWords.length,
    currentWordIndex,
    characterOffset: answerWords[currentWordIndex]?.end ?? 0,
    ratio: (currentWordIndex + 1) / answerWords.length,
    confidence,
  };
}
