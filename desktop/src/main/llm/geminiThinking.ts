/** Keep the model's visible-answer budget available without mixing API dialects. */
export function fastThinkingConfig(model: string): { thinkingBudget: number } | { thinkingLevel: 'minimal' } | undefined {
  if (/^gemini-2\.5-flash(?:-lite)?(?:$|-)/i.test(model)) return { thinkingBudget: 0 };
  if (/^gemini-3(?:\.\d+)?-flash(?:$|-)/i.test(model)) return { thinkingLevel: 'minimal' };
  return undefined;
}
