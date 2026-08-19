/**
 * Rough token estimation with no tokenizer dependency: ~4 characters per
 * token is the standard back-of-envelope ratio for English text and holds
 * up well enough for budget-fitting purposes (we're deciding what to
 * include, not billing anyone). Good enough; a real tokenizer is not worth
 * a dependency for this.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
