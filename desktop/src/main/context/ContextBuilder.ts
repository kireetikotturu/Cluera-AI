import type { AnswerContext, ContextChunk, QuestionIntent, ScreenContext, Session } from '../../shared/types';
import { Repositories } from '../database/Repositories';
import { LocalRetriever } from '../retrieval/LocalRetriever';
import type { CompactScreenRequestContext } from '../screen/ScreenAnalyzer';

export class ContextBuilder {
  constructor(private readonly repositories: Repositories, private readonly retriever: LocalRetriever) {}

  build(session: Session, intent: QuestionIntent, screenContext?: ScreenContext): AnswerContext {
    const chunks = this.retriever.retrieve(session.id, intent.question);
    const byType = (type: ContextChunk['documentType']): ContextChunk[] => chunks.filter((c) => c.documentType === type);
    const fallback = (type: ContextChunk['documentType'], text: string, section: string, limit: number): ContextChunk[] => text.trim() ? [{
      id: `session-${type}`, sessionId: session.id, documentId: `session-${type}`, documentType: type,
      section, page: null, chunkIndex: 0, text: text.trim().slice(0, limit), score: 0,
    }] : [];
    const resumeContext = byType('resume');
    const jobContext = byType('job-description');
    const needsBroadPersonalContext = ['BEHAVIORAL_QUESTION', 'EXPERIENCE_QUESTION'].includes(intent.intent)
      || /introduce yourself|tell me about yourself|your background|your experience|your (?:recent |own )?project/i.test(intent.question);
    const recentConversation = this.repositories.contextTurns(session.id, 30).map((turn) => ({
      ...turn,
      // Candidate/interviewer speech is more useful than repeating a whole old AI answer.
      text: turn.text.slice(0, turn.speaker === 'copilot' ? 500 : 1_000),
    }));
    return {
      question: intent.question, intent: intent.intent, recentConversation,
      resumeContext: resumeContext.length ? resumeContext : needsBroadPersonalContext ? fallback('resume', session.resumeText, 'Resume fallback', 8_000) : [],
      jobContext: jobContext.length ? jobContext : needsBroadPersonalContext ? fallback('job-description', session.jobDescription, 'Job description fallback', 6_000) : [],
      documentContext: [...byType('supporting'), ...byType('round-context')],
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
