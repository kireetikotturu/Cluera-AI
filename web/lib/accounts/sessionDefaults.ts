import {z} from 'zod';

/** The starting texts and recommended model for new desktop sessions. The Admin can change them; a blank value
 * means "use the built-in one". Keep the two texts identical to the ones in desktop/src/shared (a test checks it). */
export const BUILT_IN_SESSION_DEFAULTS={
 interviewContext:'Give me direct, clear answers in simple English, the way a person really talks in a live conversation. Keep sentences short and easy to say out loud, avoid jargon and textbook language, and sound calm, natural and confident. Answer exactly what was asked, then add one useful detail or example from my own background when it fits.',
 assignmentContext:'I am going to write an assignment. It has rounds such as MCQ and coding in Java, SQL and Python, plus aptitude, reasoning and math. For multiple choice questions give the correct option. For coding questions give correct, complete code in the language the question asks for. Keep every answer accurate and short.',
 assignmentModel:'gpt-6-luna',
} as const;

const modelId=/^[A-Za-z0-9][A-Za-z0-9._-]{1,99}$/;

/** What the Admin may save. An empty string resets that field to the built-in value. */
export const sessionDefaultsInput=z.object({
 interviewContext:z.string().trim().max(4000),
 assignmentContext:z.string().trim().max(4000),
 assignmentModel:z.string().trim().refine(value=>value===''||modelId.test(value),'Use a model ID exactly as the provider names it, or leave it empty.'),
}).strict();
export type SessionDefaultsInput=z.infer<typeof sessionDefaultsInput>;

export interface SessionDefaults{interviewContext:string;assignmentContext:string;assignmentModel:string}

/** The values the app uses: stored ones, with the built-in value wherever one is blank or unusable. */
export function effectiveSessionDefaults(stored:unknown):SessionDefaults{
 const record=stored&&typeof stored==='object'?stored as Record<string,unknown>:{};
 const text=(key:'interviewContext'|'assignmentContext')=>{const value=typeof record[key]==='string'?(record[key] as string).trim():'';return value&&value.length<=4000?value:BUILT_IN_SESSION_DEFAULTS[key];};
 const model=typeof record.assignmentModel==='string'?record.assignmentModel.trim():'';
 return {interviewContext:text('interviewContext'),assignmentContext:text('assignmentContext'),assignmentModel:modelId.test(model)?model:BUILT_IN_SESSION_DEFAULTS.assignmentModel};
}
