import { DEFAULT_SESSION_CONTEXT } from './answerPreferences';

/** An interview session answers a live interviewer. An assignment session answers test questions (MCQ, coding, aptitude…). */
export type SessionKind = 'interview' | 'assignment';

export const ASSIGNMENT_STYLE_DIRECT = 'Direct answer only';
export const ASSIGNMENT_STYLE_EXPLAINED = 'Answer with explanation';
export type AssignmentAnswerMode = 'direct' | 'explained';

export const assignmentModeOf = (answerStyle: string | undefined): AssignmentAnswerMode =>
  answerStyle === ASSIGNMENT_STYLE_EXPLAINED ? 'explained' : 'direct';

export const DEFAULT_ASSIGNMENT_CONTEXT = 'I am going to write an assignment. It has rounds such as MCQ and coding in Java, SQL and Python, plus aptitude, reasoning and math. For multiple choice questions give the correct option. For coding questions give correct, complete code in the language the question asks for. Keep every answer accurate and short.';

/** The recommended model for assignment sessions until the Admin chooses another one. */
export const DEFAULT_ASSIGNMENT_MODEL = 'gpt-6-luna';

/** The starting texts and recommended model for new sessions. The Admin can change them; these are the fallbacks. */
export interface SessionDefaults {
  interviewContext: string;
  assignmentContext: string;
  assignmentModel: string;
}

export const BUILT_IN_SESSION_DEFAULTS: SessionDefaults = {
  interviewContext: DEFAULT_SESSION_CONTEXT,
  assignmentContext: DEFAULT_ASSIGNMENT_CONTEXT,
  assignmentModel: DEFAULT_ASSIGNMENT_MODEL,
};

/** Accepts anything received from the server; a missing, blank or odd value falls back to the built-in one. */
export function resolveSessionDefaults(value: unknown): SessionDefaults {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const text = (key: 'interviewContext' | 'assignmentContext', limit: number): string => {
    const raw = typeof record[key] === 'string' ? (record[key] as string).trim() : '';
    return raw && raw.length <= limit ? raw : BUILT_IN_SESSION_DEFAULTS[key];
  };
  const model = typeof record.assignmentModel === 'string' ? record.assignmentModel.trim() : '';
  return {
    interviewContext: text('interviewContext', 4_000),
    assignmentContext: text('assignmentContext', 4_000),
    assignmentModel: /^[A-Za-z0-9][A-Za-z0-9._-]{1,99}$/.test(model) ? model : BUILT_IN_SESSION_DEFAULTS.assignmentModel,
  };
}
