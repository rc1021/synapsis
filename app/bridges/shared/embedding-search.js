/**
 * Embedding search wrapper — CJS bridge to ESM embedding tools.
 *
 * Uses dynamic import() to load the ESM embedder module.
 * Model is cached after first load (singleton across calls).
 */

const fs = require('fs');
const path = require('path');

const EMBEDDING_TOOLS = path.join(__dirname, '..', '..', 'tools', 'embedding');
const WORKSPACES_DIR = path.join(__dirname, '..', '..', 'workspaces', 'data');

// Cache dynamic imports (loaded once per process)
let embedFn = null;
let similarityFn = null;

async function loadModules() {
  if (!embedFn) {
    const embedMod = await import(`file://${EMBEDDING_TOOLS}/lib/embedder.js`);
    const simMod = await import(`file://${EMBEDDING_TOOLS}/lib/similarity.js`);
    embedFn = embedMod.embed;
    similarityFn = simMod.findTopSimilar;
  }
}

/**
 * Search a workspace's embeddings for the given query.
 *
 * @param {string} wsPath - Absolute path to workspace directory
 * @param {string} query  - Natural language search query
 * @param {number} topN   - Number of results (default: 5)
 * @returns {Promise<Array<{ score: number, title: string, path: string }>>}
 */
async function searchWorkspace(wsPath, query, topN = 5) {
  await loadModules();

  const indexFile = path.join(wsPath, 'embeddings.json');
  let index;
  try {
    index = JSON.parse(fs.readFileSync(indexFile, 'utf-8'));
  } catch {
    return [];
  }

  const entries = Object.entries(index.notes || {}).map(([key, val]) => ({ key, ...val }));
  if (entries.length === 0) return [];

  const queryEmbedding = await embedFn(query);
  const results = similarityFn(queryEmbedding, entries, Math.min(topN, 20));

  return results.map(r => ({
    score: parseFloat(r.score.toFixed(3)),
    title: index.notes[r.key]?.title || r.key,
    path: r.key,
  }));
}

module.exports = { searchWorkspace };
