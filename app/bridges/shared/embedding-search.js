/**
 * Embedding search wrapper — CJS bridge to ESM embedding tools.
 *
 * Uses dynamic import() to load the ESM embedder module.
 * Model is cached after first load (singleton across calls).
 *
 * Search is hybrid: a date hint in the query (e.g. "4到5月", "上週") is
 * matched directly against note paths/dates — embeddings carry no date
 * information, so a pure semantic search on a date-only query returns
 * near-flat, meaningless scores. Filename/title/tag matches are also
 * checked directly before falling back to semantic similarity.
 */

const fs = require('fs');
const path = require('path');
const { parseDateHints, extractNoteDate, noteMatchesDate, lexicalScore, isTrivialQuery } = require('./search-query');

const EMBEDDING_TOOLS = path.join(__dirname, '..', '..', 'tools', 'embedding');

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

function emptyResult() {
  return { results: [], dateRangeRequested: false, dateRangeMatched: false, lowConfidence: false };
}

function toResult(matchType, score, index, key, title) {
  return {
    matchType,
    score: typeof score === 'number' ? parseFloat(score.toFixed(3)) : score,
    title: title || index.notes[key]?.title || key,
    path: key,
  };
}

/**
 * Search a workspace's embeddings for the given query.
 *
 * @param {string} wsPath - Absolute path to workspace directory
 * @param {string} query  - Natural language search query
 * @param {number} topN   - Number of results (default: 5)
 * @returns {Promise<{
 *   results: Array<{ matchType: 'date'|'date+topic'|'lexical'|'semantic', score: number, title: string, path: string }>,
 *   dateRangeRequested: boolean,
 *   dateRangeMatched: boolean,
 *   lowConfidence: boolean,
 * }>}
 */
async function searchWorkspace(wsPath, query, topN = 5) {
  await loadModules();

  const indexFile = path.join(wsPath, 'embeddings.json');
  let index;
  try {
    index = JSON.parse(fs.readFileSync(indexFile, 'utf-8'));
  } catch {
    return emptyResult();
  }

  const entries = Object.entries(index.notes || {}).map(([key, val]) => ({ key, ...val }));
  if (entries.length === 0) return emptyResult();

  const { ranges: dateRanges, cleanedQuery } = parseDateHints(query);
  const dateRangeRequested = dateRanges.length > 0;
  const hasTopic = !isTrivialQuery(cleanedQuery);

  const dateMatches = dateRangeRequested ? entries.filter(e => noteMatchesDate(e.key, dateRanges)) : [];
  const dateRangeMatched = dateMatches.length > 0;

  if (dateRangeMatched) {
    const results = [];
    if (hasTopic) {
      // Mixed query (e.g. "5月關於投資的筆記") — rank the date-matched notes by topic
      const queryEmbedding = await embedFn(cleanedQuery);
      const ranked = similarityFn(queryEmbedding, dateMatches, Math.min(topN, dateMatches.length));
      for (const r of ranked) results.push(toResult('date+topic', r.score, index, r.key));
    } else {
      // Pure date query — most recent first
      const sorted = [...dateMatches].sort((a, b) => extractNoteDate(b.key).start - extractNoteDate(a.key).start);
      for (const e of sorted.slice(0, topN)) results.push(toResult('date', 1, index, e.key));
    }
    return { results, dateRangeRequested, dateRangeMatched, lowConfidence: false };
  }

  // No date filter (or nothing found in that range) — lexical match first, then semantic fallback
  const lexQuery = cleanedQuery || query;
  const lexCandidates = entries
    .map(e => ({ ...e, lexScore: lexicalScore(lexQuery, e) }))
    .filter(e => e.lexScore >= 0.8)
    .sort((a, b) => b.lexScore - a.lexScore)
    .slice(0, topN);

  const results = lexCandidates.map(e => toResult('lexical', e.lexScore, index, e.key, e.title));

  const remaining = topN - results.length;
  if (remaining > 0) {
    const semanticQuery = (hasTopic ? cleanedQuery : query).trim();
    if (semanticQuery) {
      const lexKeys = new Set(lexCandidates.map(e => e.key));
      const semanticCandidates = entries.filter(e => !lexKeys.has(e.key));
      if (semanticCandidates.length) {
        const queryEmbedding = await embedFn(semanticQuery);
        const ranked = similarityFn(queryEmbedding, semanticCandidates, Math.min(remaining, 20));
        for (const r of ranked) results.push(toResult('semantic', r.score, index, r.key));
      }
    }
  }

  const lowConfidence = results.length > 0
    && results.every(r => r.matchType === 'semantic')
    && results[0].score < 0.55;

  return { results, dateRangeRequested, dateRangeMatched, lowConfidence };
}

module.exports = { searchWorkspace };
