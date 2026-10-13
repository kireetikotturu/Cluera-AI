import { describe, expect, it } from 'vitest';
import type { AnswerContext, Session } from '../src/shared/types';
import { PromptBuilder } from '../src/main/llm/PromptBuilder';
import { SPOKEN_ANSWER_STYLE } from '../src/main/llm/spokenAnswerStyle';

const session: Session = { id:'1',title:'Test',role:'Engineer',company:'Acme',interviewType:'mixed',language:'English',answerStyle:'Natural',answerLength:'short',jobDescription:'',resumeText:'',instructions:'Use real experience.',selectedModel:'gemini',createdAt:'',updatedAt:'' };

describe('PromptBuilder', () => {
  it('includes grounding and anti-invention rules', () => {
    const context: AnswerContext = { question:'Tell me about React.',intent:'TECHNICAL_QUESTION',recentConversation:[],resumeContext:[],jobContext:[],documentContext:[],instructions:session.instructions,session };
    const prompt = new PromptBuilder().build(context);
    expect(prompt).toContain('Never invent');
    expect(prompt).toContain('Tell me about React.');
    expect(prompt).toContain('2-4 natural sentences');
    expect(prompt).toContain('Prefer a short natural paragraph for ordinary questions');
    expect(prompt).toContain('Begin with the direct definition, conclusion, or answer');
    expect(prompt).toContain(SPOKEN_ANSWER_STYLE);
    expect(prompt).toContain('O(n^2) time and O(1) extra space');
    expect(prompt).not.toContain('use this clear order when relevant: **Approach**');
  });
  it('includes only approved screen context when supplied', () => {
    const context: AnswerContext = { question:'Fix this error',intent:'CODING_QUESTION',recentConversation:[],resumeContext:[],jobContext:[],documentContext:[],instructions:'',session,
      screenContext:{sourceName:'Editor',capturedAt:new Date().toISOString(),visibleText:'Type error',codeOrProblem:'Fix compile error',errorMessages:['TS2322'],constraints:['strict'],summary:'A type mismatch',confidence:.9} };
    expect(new PromptBuilder().build(context)).toContain('TS2322');
    expect(new PromptBuilder().build({ ...context, screenContext: undefined })).toContain('No screen was analyzed');
  });
  it('sets the authorized interview role and carries session conversation memory', () => {
    const context: AnswerContext = { question:'Solve the visible problem in Python.',intent:'CODING_QUESTION',recentConversation:[
      { id:'t1',sessionId:'1',speaker:'interviewer',text:'We are discussing graph traversal.',createdAt:'' },
      { id:'t2',sessionId:'1',speaker:'candidate',text:'I would begin with breadth-first search.',createdAt:'' },
    ],resumeContext:[],jobContext:[],documentContext:[],instructions:'',session };
    const prompt = new PromptBuilder().build(context);
    expect(prompt).toContain('practice and authorized-session copilot');
    expect(prompt).toContain('We are discussing graph traversal.');
    expect(prompt).toContain('CANDIDATE ACTUALLY SAID: I would begin with breadth-first search.');
    expect(prompt).toContain('time/space complexity');
  });
  it('requires a complete resume-grounded self-introduction', () => {
    const context: AnswerContext = { question:'Give me a self introduction.',intent:'GENERAL_QUESTION',recentConversation:[],resumeContext:[],jobContext:[],documentContext:[],instructions:'',session };
    const prompt = new PromptBuilder().build(context);
    expect(prompt).toContain('complete spoken answer rather than a greeting or fragment');
    expect(prompt).toContain("professional identity");
    expect(prompt).toContain('evidence-backed highlights');
  });
});
