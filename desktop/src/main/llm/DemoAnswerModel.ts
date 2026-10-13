import type { AnswerContext } from '../../shared/types';
import type { AnswerModel } from './AnswerModel';

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class DemoAnswerModel implements AnswerModel {
  readonly name = 'Local demo model';
  constructor(private readonly tokenDelayMs = 16) {}

  async *streamAnswer(context: AnswerContext, signal: AbortSignal): AsyncIterable<string> {
    const evidence = context.resumeContext[0]?.text ?? context.documentContext[0]?.text;
    const answer = this.compose(context, evidence);
    for (const word of answer.split(/(\s+)/)) {
      if (signal.aborted) return;
      if (this.tokenDelayMs > 0) await wait(this.tokenDelayMs);
      yield word;
    }
  }

  private compose(context: AnswerContext, evidence?: string): string {
    const question = context.question.replace(/\s+(Keep|Expand|Make|Use) the answer.*$/i, '').trim();
    const lower = question.toLowerCase();
    if (evidence) {
      const clean = evidence.replace(/\s+/g, ' ').slice(0, context.session.answerLength === 'short' ? 240 : 520);
      return `For “${question}”, the most relevant fact from my background is that ${clean.charAt(0).toLowerCase()}${clean.slice(1)}. I would connect that experience directly to the role, explain the decisions I personally made, and be clear about the result without claiming anything beyond the supplied context.`;
    }
    if (context.intent === 'BEHAVIORAL_QUESTION') {
      return `For “${question}”, I would choose one real situation, state the responsibility I owned, explain the actions I personally took, and finish with the result and lesson learned. This demo session does not contain enough matching resume evidence to write an honest STAR story, so it deliberately avoids inventing one.`;
    }
    if (/authenticat|authoriz|oauth|jwt|session/.test(lower)) return 'I would separate authentication from authorization, use a proven identity flow, store credentials securely, and enforce access control on the server for every protected operation. I would also use short-lived tokens or secure sessions, rotate secrets, rate-limit sensitive endpoints, log security events without leaking credentials, and test both allowed and denied paths.';
    if (/react|frontend|component|hook/.test(lower)) return 'I would structure the React solution around small components with clear responsibilities, keep state as local as practical, and isolate server-state concerns from UI state. I would cover accessibility, loading and error states, stable rendering, and user-visible tests before optimizing based on measurements.';
    if (/api|backend|rest|graphql/.test(lower)) return 'I would begin with a clear API contract, validate every input, authenticate and authorize on the server, and return consistent error shapes. I would keep business logic separate from transport code, add idempotency where retries are possible, instrument latency and failures, and cover the contract with integration tests.';
    if (/database|sql|mongodb|query|index/.test(lower)) return 'I would choose the data model from the access patterns, enforce data integrity, and add indexes for measured query needs. I would review query plans, bound pagination, handle transactions explicitly, and design backup, migration, and rollback paths before treating the database as production-ready.';
    if (context.intent === 'SYSTEM_DESIGN') return `For “${question}”, I would first clarify scale, latency, consistency, availability, and security requirements. Then I would outline the main components and data flow, identify bottlenecks and failure modes, and explain how partitioning, caching, queues, observability, and graceful degradation affect the trade-offs.`;
    if (context.intent === 'CODING_QUESTION') return `For “${question}”, I would restate the inputs, outputs, constraints, and edge cases before coding. I would describe a straightforward solution, improve it only when the constraints justify the complexity, then walk through correctness, time and space complexity, and focused tests.`;
    return `For “${question}”, I would answer the specific requirement directly, explain the approach and trade-offs, and describe how I would validate the result. This is the local demo provider, so it gives a question-aware example but does not pretend to be Gemini or invent personal experience.`;
  }
}
