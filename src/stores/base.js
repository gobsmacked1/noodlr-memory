/**
 * VectorStore interface (documentation only; JS has no interfaces).
 *
 * All stores implement:
 *   async init(): Promise<void>
 *   async upsert(collection, items): void
 *       items: { id?, vector:number[], text:string, hash:number, index:number, metadata:object }[]
 *   async query(collection, vector, topK, threshold): QueryHit[]
 *       QueryHit: { id, score, text, hash, metadata }
 *   async listHashes(collection): number[]
 *   async remove(collection, { ids?, hashes? }): void
 *   async purge(collection): void
 *   async purgeAll(): void
 *   async stats(): Record<collection, { count:number }>
 *   get name(): string
 *
 * Scores are normalized so 1 = identical, 0 = unrelated (cosine similarity).
 */
export function normalizeCosineFromL2Distance(distance) {
  // Chroma cosine "distance" is 1 - cosineSimilarity, in [0,2].
  const score = 1 - Number(distance);
  return Math.max(0, Math.min(1, score));
}
