import { describe, expect, it } from 'vitest';
import type { AnswerContext, Session } from '../src/shared/types';
import { DemoAnswerModel } from '../src/main/llm/DemoAnswerModel';

const session:Session={id:'1',title:'Demo',role:'Engineer',company:'',interviewType:'technical',language:'English',answerStyle:'Natural',answerLength:'short',jobDescription:'',resumeText:'',instructions:'',selectedModel:'demo',createdAt:'',updatedAt:''};
const context=(question:string):AnswerContext=>({question,intent:'TECHNICAL_QUESTION',recentConversation:[],resumeContext:[],jobContext:[],documentContext:[],instructions:'',session});
async function answer(question:string):Promise<string>{let output='';for await(const token of new DemoAnswerModel(0).streamAnswer(context(question),new AbortController().signal))output+=token;return output;}

describe('DemoAnswerModel',()=>{
  it('returns question-aware examples instead of one repeated fallback',async()=>{const auth=await answer('How do you implement authentication?');const react=await answer('How do React hooks work?');expect(auth).toContain('authentication');expect(react).toContain('React');expect(auth).not.toBe(react);});
});
