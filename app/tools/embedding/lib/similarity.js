/**
 * Cosine similarity between two vectors.
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number} similarity score between -1 and 1
 */
export function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Find top-N most similar items from a list.
 * @param {number[]} query - query embedding
 * @param {Array<{key: string, embedding: number[]}>} items
 * @param {number} topN
 * @returns {Array<{key: string, score: number}>}
 */
export function findTopSimilar(query, items, topN = 5) {
  return items
    .map(({ key, embedding }) => ({ key, score: cosineSimilarity(query, embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);
}
