import type { QuestionIntent, QuestionIntentName } from '../../shared/types';
import { SCENARIO_CUE } from './autoQuestionAssembler';

/** Words people say before the actual request: "Okay, so first, please …". */
const LEAD_IN = /^(?:(?:my (?:next |first )?question is|the (?:next |first )?question is|next question|first question|first of all|firstly|first|so|okay|ok|alright|all right|well|and|also|now|then|next|great|good morning|good afternoon|good evening|good|nice|perfect|super|cool|sure|fine|yeah|yes|hmm+|um+|uh+|actually|basically|please|kindly|briefly|quickly|just|hi|hello|hey|thank you|thanks)(?![\p{L}\p{N}'])[\s,.!?:;-]*)+/iu;
const SMALL_TALK = /^(?:okay|ok|great|good|nice|thanks|thank you|perfect|sounds good|all right|alright|sure|yes|yeah|no|fine|cool|got it|i see|interesting|awesome|very good|right|that(?:'s| is) (?:good|great|nice|fine|correct|right|ok|okay)|will do|no problem|you too|good morning|good afternoon|good evening)[.!, ]*$/i;
/** Talk about the meeting itself that needs no answer. */
const MEETING_TALK = /^(?:take (?:your time|care|some time|a (?:moment|minute|second|sec|break|seat))(?: (?:to|and) (?:think|read|review|prepare)[^.?!]*)?|give (?:me|us) (?:a |one )?(?:sec|second|minute|moment)|(?:one|just a|wait a) (?:sec|second|minute|moment)|hold on|wait|let'?s (?:move on|continue|proceed)|moving on|bye(?: bye)?|see you.*|have a (?:nice|good|great) (?:day|one|evening|weekend))[.!, ]*$/i;
const INCOMPLETE = /\b(and|or|also|because|when|while|with|about|to|for|on|in|using|through|how you|what you|tell me)\s*$/i;
/** "Which projects have you worked on" is whole once the speaker has stopped, although it ends with a preposition. */
const WH_QUESTION = /^(?:what|which|who|whom|where|how)\b/i;
const FINAL_PREPOSITION = /\b(?:with|on|in|for|to|about|using)$/i;
/** A question or instruction that starts the sentence (after any lead-in). */
const REQUEST_START = /^(?:what|why|how|when|where|which|who|whom|whose|can|could|would|will|do|does|did|have|has|are|is|may i|shall we|tell|describe|explain|walk|give|share|design|implement|write|solve|analy[sz]e|compare|define|differentiate|distinguish|find|calculate|compute|evaluate|predict|identify|choose|select|determine|complete|fix|convert|print|rewrite|simplify|prove|derive|elaborate|summari[sz]e|introduce|discuss|illustrate|demonstrate|mention|suggest|provide|outline|take|assume|suppose|imagine|consider|show (?:me|us)|name (?:the|a|an|any|some|all|few|two|three|four|five|six|ten|\d+)|answer (?:the|this|that|these|those|my|all|each|any|a|an|me|us)|brief (?:me|us|about|on)|list(?: (?:out|some|any|the|down|all))?|state (?:the|any|some)|create (?:a|an|the)|build (?:a|an|the)|let(?:'s| us) (?:discuss|talk about)|(?:let(?:'s| us) )?(?:start|begin) (?:with|by) (?:your|explaining|telling|describing|introducing))\b/i;
/** Asking the candidate directly, wherever it comes in the sentence. */
const DIRECT_REQUEST = /\b(?:tell (?:me|us)|walk (?:me|us) through|talk about|introduce your ?self|about your ?self|who are you|your name|(?:i|we)(?:'d| would)? (?:like|want) (?:you to|to (?:know|understand|hear|ask))|i need you to|can you|could you|would you|will you|how would you|how do you|how will you|what would you|let me know|explain (?:me|us|to me|to us))\b/i;
const INTRODUCTION = /\b(?:introduce your ?self|intro your ?self|about your ?self|who are you|your name|(?:self|your(?: (?:brief|short|self|quick))?|brief|short|quick)[ -]?intro(?:duction)?)\b/i;
/** Praise after the candidate's introduction ("Nice self introduction"), not a request for one. */
const PRAISED_INTRODUCTION = /\b(?:good|nice|great|excellent|wonderful|awesome|impressive|lovely|perfect)(?: (?:a|an|your|the))?(?: (?:brief|short|self|quick))?[ -]?intro(?:duction)?\b/i;
/** A task described without a request word, even when speech recognition mishears that word ("Ride a program for …"). */
const PROGRAM_TASK = /\b(?:program|code|function|query|script|algorithm) (?:for|to|that|which)\b/i;
const ASKED_TOPIC = /\b(?:differences? between|your (?:thoughts|opinion|view|take) (?:on|about))\b/i;
const ABOUT_THEMSELVES = /\b(?:we|our|us)\b/i;
const OWN_WORDS = /\b(?:i|my)\b/i;
/** The task after a situation, in the same sentence: "Given an array, find the …". Counts only after a situation. */
const CLAUSE_REQUEST = /,\s*(?:(?:so|and|now|then|please|kindly)\s+)*(?:(?:explain|describe|tell (?:me|us)|walk (?:me|us)|how (?:would|will|do) you|what (?:would|will) you)\b|(?:write|design|implement|solve|compare|define|find|calculate|return|reverse|sort|count) (?:a|an|the|this|that|these|those|all|how|your|its|their|it|each|them)\b)/i;
/** The interviewer talking about themselves or the company, not asking. */
const OWN_STATEMENT = /^(?:i |i'm |i am |i've |i have |i will |i'll |my name|we |we're |we are |we've |we have |we will |we'll |our |this is |here (?:is|we) |let me (?:tell|share|give|start|introduce|show)|thank(?:s| you) for\b)/i;

const withoutLeadIn = (text: string): string => text.replace(LEAD_IN, '').trim();
const scenarioTask = (part: string): boolean => (SCENARIO_CUE.test(part) || /^if\b/i.test(part)) && CLAUSE_REQUEST.test(part);

export class IntentDetector {
  /** `speakerFinished`: the speaker stayed quiet long enough that the text is the whole of what they said. */
  detect(raw: string, options: { speakerFinished?: boolean } = {}): QuestionIntent {
    const text = raw.replace(/\s+/g, ' ').trim();
    const core = withoutLeadIn(text);
    if (!core || SMALL_TALK.test(text) || SMALL_TALK.test(core) || MEETING_TALK.test(text) || MEETING_TALK.test(core)) return this.result(false, 'SMALL_TALK', 0.96, text, true, false);
    const incompleteProbe = text.replace(/[.…,;:!]+$/g, '').trim();
    const words = text.split(' ').length;
    // "Introduce yourself" or "Self introduction" is short but a whole question.
    const introduction = INTRODUCTION.test(text);
    const direct = DIRECT_REQUEST.test(text);
    const sentences = text.split(/(?<=[.!?])\s+/);
    const asks = (part: string): boolean => {
      const start = withoutLeadIn(part);
      return !MEETING_TALK.test(start) && !SMALL_TALK.test(start) && (part.includes('?') || REQUEST_START.test(start) || scenarioTask(start));
    };
    // "I have a question. Explain closures." asks in a later sentence.
    const askedLater = sentences.slice(1).some(asks);
    const likelyQuestion = text.includes('?') || introduction || direct || REQUEST_START.test(core) || scenarioTask(core) || askedLater
      || (!ABOUT_THEMSELVES.test(text) && (ASKED_TOPIC.test(text) || (PROGRAM_TASK.test(text) && !OWN_WORDS.test(text))));
    if (!introduction) {
      const trailing = INCOMPLETE.test(incompleteProbe)
        && !(options.speakerFinished && words >= 4 && WH_QUESTION.test(core) && FINAL_PREPOSITION.test(incompleteProbe));
      // Two words are enough for "Why Java?" or "Explain closures.", not for "Tell me".
      const shortRequest = words === 2 && (text.endsWith('?')
        || /^(?:explain|define|describe|elaborate|compare|differentiate) (?!(?:you|me|us|it|this|that|the|a|an)\b)\p{L}/iu.test(core));
      if (trailing || (words < 3 && !shortRequest)) return this.result(false, 'CONTEXT_ONLY', 0.78, text, false, true);
    }
    const notAsking = !direct && !text.includes('?') && !askedLater
      && (PRAISED_INTRODUCTION.test(text) || (!scenarioTask(core) && (OWN_STATEMENT.test(text) || OWN_STATEMENT.test(core))));
    if (!likelyQuestion || notAsking) return this.result(false, 'NO_ANSWER_NEEDED', 0.84, text, true, false);

    let intent: QuestionIntentName = 'GENERAL_QUESTION';
    if (/\b(star|conflict|challenge|failure|mistake|leadership|difficult|situation|time when)\b/i.test(text)) intent = 'BEHAVIORAL_QUESTION';
    else if (/\b(experiences?|worked with|background|projects?|resume|introduce yourself|about yourself)\b/i.test(text) || introduction) intent = 'EXPERIENCE_QUESTION';
    else if (/\b(code|algorithm|complexity|function|implement|debug|leetcode|data structure|program)\b/i.test(text)) intent = 'CODING_QUESTION';
    else if (/\b(system design|scale|architecture|high availability|distributed|load balancer|database design)\b/i.test(text)) intent = 'SYSTEM_DESIGN';
    else if (/\b(react|node|typescript|javascript|python|java|database|sql|api|cloud|aws|docker|kubernetes|mongodb|authentication|authorization)\b/i.test(text)) intent = 'TECHNICAL_QUESTION';
    else if (/^(and|also|why|how about|what about)\b/i.test(text)) intent = 'FOLLOW_UP';
    if ((text.match(/\?/g) ?? []).length > 1 || (!/^and\b/i.test(text) && /\b(and also|as well as|and (?:then )?(?:how|what|why|when|where|can|could|would|did|do))\b/i.test(text))) intent = 'MULTI_PART_QUESTION';
    // A situation described first and asked about last is one question: keep all of it, not just the final sentence.
    const keepWhole = text.length >= 160 || SCENARIO_CUE.test(text);
    const realQuestion = intent !== 'MULTI_PART_QUESTION' && sentences.length > 1 && !keepWhole
      ? [...sentences].reverse().find(asks) ?? text : text;
    return this.result(true, intent, text.includes('?') ? 0.94 : 0.87, realQuestion, true, intent === 'FOLLOW_UP');
  }

  private result(isAnswerNeeded: boolean, intent: QuestionIntentName, confidence: number, question: string, isComplete: boolean, requiresMoreContext: boolean): QuestionIntent {
    return { isAnswerNeeded, intent, confidence, question, isComplete, requiresMoreContext };
  }
}
