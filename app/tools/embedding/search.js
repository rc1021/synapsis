#!/usr/bin/env node

/**
 * Embedding Search — find semantically similar learning notes.
 * Usage:
 *   node search.js "穩定幣結算"              → text query
 *   node search.js --note 2026/03/2026-03-04-13.md  → find similar to a note
 *   node search.js --top 10 "跨境匯款"       → change result count
 */

import { pipeline } from '@xenova/transformers';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findTopSimilar } from './lib/similarity.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const LEARNING_DIR = join(__dirname, '../../workspace/memory/learning');
const INDEX_FILE = join(LEARNING_DIR, 'embeddings.json');
const MODEL_NAME = 'Xenova/all-MiniLM-L6-v2';

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = { topN: 5, noteKey: null, query: null };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--note' && args[i + 1]) {
      opts.noteKey = args[++i];
    } else if (args[i] === '--top' && args[i + 1]) {
      opts.topN = parseInt(args[++i], 10);
    } else if (!args[i].startsWith('--')) {
      opts.query = args[i];
    }
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv);

  if (!opts.query && !opts.noteKey) {
    console.log('Usage:');
    console.log('  node search.js "query text"');
    console.log('  node search.js --note 2026/03/2026-03-04-13.md');
    console.log('  node search.js --top 10 "query"');
    process.exit(0);
  }

  // Load index
  let index;
  try {
    const raw = await readFile(INDEX_FILE, 'utf-8');
    index = JSON.parse(raw);
  } catch {
    console.error('❌ embeddings.json not found. Run `node index.js` first.');
    process.exit(1);
  }

  const entries = Object.entries(index.notes).map(([key, val]) => ({
    key,
    ...val,
  }));

  let queryEmbedding;

  if (opts.noteKey) {
    // Find similar to an existing note
    const note = index.notes[opts.noteKey];
    if (!note) {
      console.error(`❌ Note not found: ${opts.noteKey}`);
      console.log('Available notes:');
      Object.keys(index.notes).forEach(k => console.log(`  ${k}`));
      process.exit(1);
    }
    queryEmbedding = note.embedding;
    console.log(`🔍 Finding notes similar to: ${note.title}\n`);
    // Exclude the query note itself
    const filtered = entries.filter(e => e.key !== opts.noteKey);
    const results = findTopSimilar(queryEmbedding, filtered, opts.topN);
    printResults(results, index.notes);
  } else {
    // Text query
    console.log(`📦 Loading model...`);
    const extractor = await pipeline('feature-extraction', MODEL_NAME);
    const output = await extractor(opts.query, { pooling: 'mean', normalize: true });
    queryEmbedding = Array.from(output.data);
    console.log(`🔍 Searching for: "${opts.query}"\n`);
    const results = findTopSimilar(queryEmbedding, entries, opts.topN);
    printResults(results, index.notes);
  }
}

function printResults(results, notes) {
  if (results.length === 0) {
    console.log('No results found.');
    return;
  }

  results.forEach((r, i) => {
    const note = notes[r.key];
    const score = (r.score * 100).toFixed(1);
    const tags = note.tags.length ? ` [${note.tags.join(', ')}]` : '';
    console.log(`${i + 1}. (${score}%) ${note.title}`);
    console.log(`   📄 ${r.key}${tags}`);
    if (note.series) console.log(`   📚 ${note.series}`);
    console.log();
  });
}

main().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
