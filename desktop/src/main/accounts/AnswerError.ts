/** A reason an answer could not be produced that is safe, and useful, to show to the customer as it is. */
export class AnswerError extends Error {
  /** `final`: trying again at once would not help, so a caller with its own retries should stop. */
  constructor(message: string, readonly final = false) { super(message); this.name = 'AnswerError'; }
}
