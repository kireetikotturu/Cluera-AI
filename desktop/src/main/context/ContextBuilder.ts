import type { AnswerContext, ContextChunk, QuestionIntent, ScreenContext, Session } from '../../shared/types';
import { Repositories } from '../database/Repositories';
import { LocalRetriever } from '../retrieval/LocalRetriever';
import type { CompactScreenRequestContext } from '../screen/ScreenAnalyzer';

/** Questions about the candidate themself: they need the whole resume, not a few matching lines. */
const PERSONAL_QUESTION = /\b(?:introduce|yourself|myself|about you|about me|who are you|your name|my name|your (?:background|experiences?|projects?|skills?|strengths?|weakness(?:es)?|education|college|degree|achievements?|career|journey|role|responsibilit\w+|favou?rite\w*|best|strongest|certifications?|internships?|work|company|companies|resume|cv|profile|tech stack|technologies)|projects? (?:you|have you|did you|you've)|what (?:have|did) you (?:do|done|built|build|work|worked)|walk (?:me )?through your)\b/i;

export class ContextBuilder {
  constructor(private readonly repositories: Repositories, private readonly retriever: LocalRetriever) {}

  build(session: Session, intent: QuestionIntent, screenContext?: ScreenContext): AnswerContext {
    const { topK } = this.retriever.settings;
    // Each kind of material is searched on its own, so a long resume cannot push the job description
    // or the candidate's typed notes out of the answer (and the other way round).
    const search = this.retriever.search(session.id, intent.question, topK);
    const chunks = [...search.matched('resume'), ...search.matched('job-description'), ...search.matched('supporting'), ...search.matched('round-context')];
    const byType = (type: ContextChunk['documentType']): ContextChunk[] => chunks.filter((c) => c.documentType === type);
    const fallback = (type: ContextChunk['documentType'], text: string, section: string, limit: number): ContextChunk[] => text.trim() ? [{
      id: `session-${type}`, sessionId: session.id, documentId: `session-${type}`, documentType: type,
      section, page: null, chunkIndex: 0, text: text.trim().slice(0, limit), score: 0,
    }] : [];
    const needsBroadPersonalContext = ['BEHAVIORAL_QUESTION', 'EXPERIENCE_QUESTION'].includes(intent.intent) || PERSONAL_QUESTION.test(intent.question);
    // The candidate's own details (name, headline, summary) are always available to the answer.
    const profile = search.leading('resume', 1);
    const matchedResume = byType('resume');
    const withProfile = (list: ContextChunk[]): ContextChunk[] =>
      profile.length && !list.some((chunk) => chunk.id === profile[0].id) ? [...profile, ...list.slice(0, topK - 1)] : list;
    let resumeContext: ContextChunk[];
    if (needsBroadPersonalContext && session.resumeText.trim()) {
      // "Introduce yourself", "your projects", "your background": the whole resume is the evidence.
      const whole = fallback('resume', session.resumeText, 'Resume', 8_000);
      resumeContext = [...whole, ...matchedResume.filter((chunk) => !whole[0].text.includes(chunk.text.slice(0, 120))).slice(0, 2)];
    } else {
      resumeContext = matchedResume.length ? withProfile(matchedResume) : profile;
    }
    const matchedJob = byType('job-description');
    const jobContext = matchedJob.length ? matchedJob : needsBroadPersonalContext ? fallback('job-description', session.jobDescription, 'Job description fallback', 6_000) : [];
    // Typed context and supporting files describe the candidate too; a personal question must see them
    // even when no word of the question appears in them.
    const matchedSupporting = [...byType('supporting'), ...byType('round-context')];
    const supportingContext = matchedSupporting.length || !needsBroadPersonalContext
      ? matchedSupporting
      : search.leading('supporting', 3);
    const recentConversation = this.repositories.contextTurns(session.id, 30).map((turn) => ({
      ...turn,
      // Candidate/interviewer speech is more useful than repeating a whole old AI answer.
      text: turn.text.slice(0, turn.speaker === 'copilot' ? 500 : 1_000),
    }));
    return {
      question: intent.question, intent: intent.intent, recentConversation,
      resumeContext,
      jobContext,
      documentContext: supportingContext,
      instructions: `${session.instructions}\nCurrent round brief: ${this.repositories.currentRound(session.id)?.note ?? ''}`.trim(), session,
      screenContext,
    };
  }

  buildCompactScreenRequest(session: Session, question: string, priorScreenContext?: ScreenContext): CompactScreenRequestContext {
    const query = `${question} ${session.role} ${session.company}`.trim();
    const chunks = this.retriever.retrieve(session.id, query, 6).map((chunk) => ({
      ...chunk,
      text: chunk.text.slice(0, 1_000),
    }));
    const byType = (type: ContextChunk['documentType']): ContextChunk[] => chunks
      .filter((chunk) => chunk.documentType === type)
      .slice(0, 2);
    return {
      session: {
        role: session.role,
        company: session.company,
        interviewType: session.interviewType,
        language: session.language,
        answerStyle: session.answerStyle,
        answerLength: session.answerLength,
        answerPreferences: session.answerPreferences,
        selectedModel: session.selectedModel,
        instructions: `${session.instructions.slice(0, 800)}\nCurrent round brief: ${this.repositories.currentRound(session.id)?.note ?? ''}`.slice(0, 2800),
      },
      recentConversation: this.repositories.contextTurns(session.id, 6).map((turn) => ({
        speaker: turn.speaker,
        text: turn.text.slice(0, 600),
      })),
      resumeContext: byType('resume'),
      jobContext: byType('job-description'),
      documentContext: [...byType('supporting'), ...byType('round-context')].slice(0, 3),
      priorScreenContext: priorScreenContext ? {
        sourceName: priorScreenContext.sourceName,
        summary: priorScreenContext.summary.slice(0, 1_000),
        codeOrProblem: priorScreenContext.codeOrProblem?.slice(0, 1_000),
        constraints: priorScreenContext.constraints.slice(0, 8),
        errorMessages: priorScreenContext.errorMessages.slice(0, 8),
        detectedLanguage: priorScreenContext.detectedLanguage,
        technologies: priorScreenContext.technologies,
        uiDetails: priorScreenContext.uiDetails?.slice(0, 800),
        currentTask: priorScreenContext.currentTask?.slice(0, 800),
      } : undefined,
    };
  }
}
