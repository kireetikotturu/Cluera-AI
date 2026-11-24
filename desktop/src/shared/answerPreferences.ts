/** How the customer wants every answer of a session to be presented. Chosen once on the Create Session page. */
export interface AnswerPreferences {
  /** An answer to read word for word. */
  fullScript: boolean;
  /** One opening line, then supporting bullets. */
  scriptWithBullets: boolean;
  /** Short bullets to say in your own words. */
  bullets: boolean;
  /** Write the way people really speak: small pauses and connecting words. */
  fillerWords: boolean;
}

export const DEFAULT_ANSWER_PREFERENCES: AnswerPreferences = {
  fullScript: false, scriptWithBullets: true, bullets: false, fillerWords: true,
};

/** Typed into the supporting-context box of every new session; the customer may edit or clear it. */
export const DEFAULT_SESSION_CONTEXT = 'Give me direct, clear answers in simple English, the way a person really talks in a live conversation. Keep sentences short and easy to say out loud, avoid jargon and textbook language, and sound calm, natural and confident. Answer exactly what was asked, then add one useful detail or example from my own background when it fits.';

const KEYS = ['fullScript', 'scriptWithBullets', 'bullets', 'fillerWords'] as const;

/** Accepts anything stored or received; unknown or missing values fall back to the defaults. */
export function normalizeAnswerPreferences(value: unknown): AnswerPreferences {
  let source: unknown = value;
  if (typeof source === 'string') {
    try { source = source.trim() ? JSON.parse(source) : undefined; } catch { source = undefined; }
  }
  const record = source && typeof source === 'object' ? source as Record<string, unknown> : {};
  const result = { ...DEFAULT_ANSWER_PREFERENCES };
  for (const key of KEYS) if (typeof record[key] === 'boolean') result[key] = record[key] as boolean;
  return result;
}

export function serializeAnswerPreferences(value: unknown): string {
  return JSON.stringify(normalizeAnswerPreferences(value));
}

/** The prompt lines that carry the customer's choice into every generated answer. */
export function answerPreferenceRules(value: unknown): string {
  const prefs = normalizeAnswerPreferences(value);
  const script = prefs.fullScript;
  const bullets = prefs.bullets;
  // Nothing selected behaves like the default format, so an answer is never left without a shape.
  const withOpening = prefs.scriptWithBullets || (!script && !bullets);
  let format: string;
  if (script && (withOpening || bullets)) {
    format = 'Write one complete script the candidate can read word for word, in short natural paragraphs, then add 2-4 short bullets under "Key points" that recap it.';
  } else if (script) {
    format = 'Write one complete script the candidate can read word for word, in short natural paragraphs. Do not use bullet points.';
  } else if (withOpening) {
    format = 'Start with one short opening line the candidate can say as-is, then give 3-5 short supporting bullets. Each bullet is one idea in a few words.';
  } else {
    format = 'Reply with only short bullet points (3-6 bullets, each one idea in a few words) that the candidate can say in their own words. Do not write a full script and do not add an opening paragraph.';
  }
  const speech = prefs.fillerWords
    ? 'Write it the way people actually speak: use natural connecting words and small pauses such as "so", "well", "actually", "you know", "I mean" and "basically", but sparingly (at most one every sentence or two), so it still sounds confident.'
    : 'Write it clean and direct without filler words, hesitations or pause words.';
  return `- ANSWER FORMAT chosen by the candidate for the whole session. It decides the shape of every answer and overrides any earlier hint about paragraphs or bullets: ${format} Code, when needed, stays in a fenced block.
- SPEECH STYLE chosen by the candidate: ${speech}`;
}
