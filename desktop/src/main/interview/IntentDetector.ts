import type { QuestionIntent, QuestionIntentName } from '../../shared/types';

const SMALL_TALK = /^(okay|ok|great|good|nice|thanks|thank you|perfect|sounds good|all right|alright)[.! ]*$/i;
const INCOMPLETE = /\b(and|or|also|because|when|while|with|about|to|for|on|in|using|through|how you|what you|tell me)\s*$/i;
const QUESTION_START = /^(what|why|how|when|where|which|who|can|could|would|will|do|did|have|has|are|is|tell|describe|explain|walk|give|share|design|implement|write|solve|analyze|analyse|compare)\b/i;

export class IntentDetector {
  detect(raw: string): QuestionIntent {
    const text = raw.replace(/\s+/g, ' ').trim();
    if (!text || SMALL_TALK.test(text)) return this.result(false, 'SMALL_TALK', 0.96, text, true, false);
    const incompleteProbe = text.replace(/[.…,;:!]+$/g, '').trim();
    if (INCOMPLETE.test(incompleteProbe) || text.split(' ').length < 3) return this.result(false, 'CONTEXT_ONLY', 0.78, text, false, true);

    const likelyQuestion = text.includes('?') || QUESTION_START.test(text) || /\b(tell me|walk me through|I'd like to know|talk about)\b/i.test(text);
    if (!likelyQuestion) return this.result(false, 'NO_ANSWER_NEEDED', 0.84, text, true, false);

    let intent: QuestionIntentName = 'GENERAL_QUESTION';
    if (/\b(star|conflict|challenge|failure|mistake|leadership|difficult|situation|time when)\b/i.test(text)) intent = 'BEHAVIORAL_QUESTION';
    else if (/\b(experience|worked with|background|project|resume)\b/i.test(text)) intent = 'EXPERIENCE_QUESTION';
    else if (/\b(code|algorithm|complexity|function|implement|debug|leetcode|data structure)\b/i.test(text)) intent = 'CODING_QUESTION';
    else if (/\b(system design|scale|architecture|high availability|distributed|load balancer|database design)\b/i.test(text)) intent = 'SYSTEM_DESIGN';
    else if (/\b(react|node|typescript|javascript|python|java|database|sql|api|cloud|aws|docker|kubernetes|mongodb|authentication|authorization)\b/i.test(text)) intent = 'TECHNICAL_QUESTION';
    else if (/^(and|also|why|how about|what about)\b/i.test(text)) intent = 'FOLLOW_UP';
    if ((text.match(/\?/g) ?? []).length > 1 || (!/^and\b/i.test(text) && /\b(and also|as well as|and (?:then )?(?:how|what|why|when|where|can|could|would|did|do))\b/i.test(text))) intent = 'MULTI_PART_QUESTION';
    const sentences = text.split(/(?<=[.!?])\s+/);
    const realQuestion = intent !== 'MULTI_PART_QUESTION' && sentences.length > 1
      ? [...sentences].reverse().find((part) => part.includes('?') || QUESTION_START.test(part)) ?? text : text;
    return this.result(true, intent, text.includes('?') ? 0.94 : 0.87, realQuestion, true, intent === 'FOLLOW_UP');
  }

  private result(isAnswerNeeded: boolean, intent: QuestionIntentName, confidence: number, question: string, isComplete: boolean, requiresMoreContext: boolean): QuestionIntent {
    return { isAnswerNeeded, intent, confidence, question, isComplete, requiresMoreContext };
  }
}
