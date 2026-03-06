#!/usr/bin/env node

/**
 * Embedding Indexer — builds embeddings.json from learning notes.
 * Usage: node index.js
 */

import { pipeline } from '@xenova/transformers';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const LEARNING_DIR = join(__dirname, '../../workspace/memory/learning');
const OUTPUT_FILE = join(LEARNING_DIR, 'embeddings.json');
const MODEL_NAME = 'Xenova/all-MiniLM-L6-v2';
const MAX_TEXT_LENGTH = 500;

/** Parse YAML frontmatter from markdown content. */
function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return { meta: {}, body: content };

  const raw = match[1];
  const meta = {};

  for (const line of raw.split('\n')) {
    const m = line.match(/^(\w+):\s*(.+)/);
    if (!m) continue;
    const [, key, val] = m;
    if (val.startsWith('[') && val.endsWith(']')) {
      meta[key] = val.slice(1, -1).split(',').map(s => s.trim());
    } else {
      meta[key] = val.replace(/^["']|["']$/g, '');
    }
  }

  const body = content.slice(match[0].length).trim();
  return { meta, body };
}

/** Extract title from first # heading. */
function extractTitle(body) {
  const m = body.match(/^#\s+(.+)/m);
  return m ? m[1].replace(/^[^\w\u4e00-\u9fff]+/, '').trim() : '';
}

/** Recursively find all .md files. */
async function findMarkdownFiles(dir) {
  const files = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await findMarkdownFiles(full));
    } else if (entry.name.endsWith('.md') && !entry.name.startsWith('series-index') && !entry.name.startsWith('sources')) {
      files.push(full);
    }
  }
  return files;
}

async function main() {
  console.log('🔍 Finding learning notes...');
  const files = await findMarkdownFiles(LEARNING_DIR);
  console.log(`   Found ${files.length} notes`);

  console.log(`📦 Loading model: ${MODEL_NAME}...`);
  const extractor = await pipeline('feature-extraction', MODEL_NAME);

  const notes = {};
  let count = 0;

  for (const file of files) {
    const relPath = relative(LEARNING_DIR, file);
    const content = await readFile(file, 'utf-8');
    const { meta, body } = parseFrontmatter(content);
    const title = extractTitle(body);

    // Build text for embedding: title + first N chars of body
    const text = `${title}\n${body.slice(0, MAX_TEXT_LENGTH)}`;

    const output = await extractor(text, { pooling: 'mean', normalize: true });
    const embedding = Array.from(output.data);

    notes[relPath] = {
      title,
      series: meta.series || '',
      tags: meta.tags || [],
      embedding,
    };

    count++;
    process.stdout.write(`\r   Indexed ${count}/${files.length}`);
  }

  console.log('\n💾 Saving embeddings.json...');
  await writeFile(OUTPUT_FILE, JSON.stringify({ notes }, null, 2));
  console.log(`✅ Done! ${count} notes indexed → ${relative(process.cwd(), OUTPUT_FILE)}`);
}

main().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
