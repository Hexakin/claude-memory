/**
 * Compute cosine similarity between two vectors.
 * Assumes both vectors are L2-normalized (so dot product = cosine similarity).
 * Falls back to full cosine formula for safety.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }

  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export interface VectorSearchResult {
  chunkId: string;
  memoryId: string;
  content: string;
  score: number;
}

/**
 * Brute-force vector search using JS cosine similarity.
 * Used as fallback when sqlite-vec is not available.
 */
export function searchVectorJS(
  queryEmbedding: Float32Array,
  chunks: Array<{ chunkId: string; memoryId: string; content: string; embedding: Float32Array }>,
  limit: number,
): VectorSearchResult[] {
  const scored = chunks.map(chunk => ({
    chunkId: chunk.chunkId,
    memoryId: chunk.memoryId,
    content: chunk.content,
    score: cosineSimilarity(queryEmbedding, chunk.embedding),
  }));

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}
