/**
 * Lightweight, dependency-free lexical-similarity layer (TF-IDF + cosine).
 *
 * This is deliberately NOT a neural embedding model -- no model download,
 * no inference runtime, no paid API, per the project's own free/open-source
 * constraint. It closes part of the "no semantic search at all" gap
 * identified against Mem0/Zep/Cognee (Wave 4/5 research), but honestly:
 * it catches shared-vocabulary paraphrases, not deep meaning. A real
 * embedding-based layer is a legitimate future upgrade, not what this is.
 */

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "is", "are", "was", "were", "be",
  "to", "of", "in", "on", "for", "with", "as", "at", "by", "this", "that",
  "it", "its", "from", "into", "not", "no", "so", "than", "then",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .filter((token) => token.length > 2 && !STOPWORDS.has(token));
}

function termFrequency(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1);
  const total = tokens.length || 1;
  for (const [term, count] of tf) tf.set(term, count / total);
  return tf;
}

export class TfIdfIndex {
  private readonly docFrequency = new Map<string, number>();
  private docCount = 0;

  constructor(corpus: string[]) {
    for (const doc of corpus) {
      this.docCount += 1;
      const seen = new Set(tokenize(doc));
      for (const term of seen) this.docFrequency.set(term, (this.docFrequency.get(term) ?? 0) + 1);
    }
  }

  private idf(term: string): number {
    const df = this.docFrequency.get(term) ?? 0;
    return Math.log((this.docCount + 1) / (df + 1)) + 1;
  }

  private vector(text: string): Map<string, number> {
    const tf = termFrequency(tokenize(text));
    const vector = new Map<string, number>();
    for (const [term, freq] of tf) vector.set(term, freq * this.idf(term));
    return vector;
  }

  /** Cosine similarity in [0, 1] between two arbitrary texts, using this corpus's IDF weights. */
  similarity(a: string, b: string): number {
    const va = this.vector(a);
    const vb = this.vector(b);
    let dot = 0;
    for (const [term, weight] of va) {
      const other = vb.get(term);
      if (other) dot += weight * other;
    }
    const magnitude = (v: Map<string, number>) => Math.sqrt([...v.values()].reduce((sum, w) => sum + w * w, 0));
    const denom = magnitude(va) * magnitude(vb);
    return denom === 0 ? 0 : dot / denom;
  }
}
