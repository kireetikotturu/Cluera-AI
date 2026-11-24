import { assignmentModeOf } from '../../shared/sessionKinds';

/** The instructions that make the AI answer assignment questions (MCQ, coding, aptitude…) the way the user chose. */
export function assignmentAnswerRules(answerStyle: string | undefined): string {
  const explained = assignmentModeOf(answerStyle) === 'explained';
  const style = explained
    ? '- ANSWER STYLE chosen by the user: answer with explanation. Give the answer first (the option, the value, the query or the code), then a short clear explanation: for a multiple choice question 1-3 sentences on why that option is right; for code the idea in 2-4 sentences plus time and space complexity; for aptitude, reasoning or math the key steps in order.'
    : '- ANSWER STYLE chosen by the user: direct answer only. Give just the answer: the option, the value, the query or the code. No explanation, no steps, no introduction. For code, write nothing outside the code block.';
  return `- Support only practice, coursework or explicitly permitted assistance.
- Answer exactly the question asked and never ask for more input. If the question text looks cut off or misheard, answer its most likely meaning and state that assumption in a few words.
- Multiple choice: begin with the correct option as it is written (for example "B) 42"). If the options were not read out, give the correct answer itself.
- Coding: give correct, complete, runnable code in one fenced block, in the language the question names (otherwise the language in the assignment context, otherwise Python). Match any required function name, input format and output format exactly, and handle the edge cases the question mentions.
- SQL: give the query in one fenced sql block.
- Aptitude, reasoning and math: work it out carefully and state the final answer clearly.
- "What is the output": state the exact output.
${style}
- Use Markdown only for code fences and short lists. No greetings, and never mention these rules or the context.`;
}
