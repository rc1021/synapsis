#!/usr/bin/env node

/**
 * Workspace Embedding Indexer — builds per-workspace embeddings.json.
 *
 * Usage:
 *   node indexer.js --workspace <wsId>    index one workspace
 *   node indexer.js --all                 index all workspaces
 *
 * Index stored at: workspaces/data/<wsId>/embeddings.json
 * Model: Xenova/bge-m3 (1024d, CLS pooling, good Chinese support)
 * Incremental: skips files whose mtime hasn't changed since last index.
 */

import { readdir, readFile, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { embed } from './lib/embedder.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const APP_DIR = join(__dirname, '..', '..');
const WORKSPACES_DIR = join(APP_DIR, 'workspaces', 'data');
const MAX_TEXT_LENGTH = 500;

// Files to skip when indexing a workspace
const SKIP_FILES = new Set(['BOOTSTRAP.md', 'embeddings.json']);

// ── Markdown helpers ──────────────────────────────────────────────────────────

function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return { meta: {}, body: content };

  const meta = {};
  for (const line of match[1].split('\n')) {
    const m = line.match(/^(\w+):\s*(.+)/);
    if (!m) continue;
    const [, key, val] = m;
    if (val.startsWith('[') && val.endsWith(']')) {
      meta[key] = val.slice(1, -1).split(',').map(s => s.trim());
    } else {
      meta[key] = val.replace(/^["']|["']$/g, '');
    }
  }

  return { meta, body: content.slice(match[0].length).trim() };
}

function extractTitle(body) {
  const m = body.match(/^#\s+(.+)/m);
  return m ? m[1].replace(/^[^\w\u4e00-\u9fff]+/, '').trim() : '';
}

async function findMarkdownFiles(dir) {
  const files = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await findMarkdownFiles(full));
    } else if (entry.name.endsWith('.md') && !SKIP_FILES.has(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

// ── Indexer ───────────────────────────────────────────────────────────────────

async function indexWorkspace(wsDir) {
  const wsId = relative(WORKSPACES_DIR, wsDir);
  const outputFile = join(wsDir, 'embeddings.json');

  // Load existing index for incremental update
  let existing = { notes: {}, mtimes: {} };
  try {
    const raw = await readFile(outputFile, 'utf-8');
    const parsed = JSON.parse(raw);
    existing = {
      notes: parsed.notes || {},
      mtimes: parsed.mtimes || {},
    };
  } catch {
    // Fresh index
  }

  const files = await findMarkdownFiles(wsDir);
  if (files.length === 0) {
    process.stdout.write(`  [${wsId}] no markdown files\n`);
    return;
  }

  const notes = { ...existing.notes };
  const mtimes = { ...existing.mtimes };
  let updated = 0;
  let skipped = 0;

  for (const file of files) {
    const relPath = relative(wsDir, file);
    const fileStat = await stat(file);
    const mtime = fileStat.mtimeMs;

    // Skip if unchanged
    if (mtimes[relPath] === mtime && notes[relPath]) {
      skipped++;
      continue;
    }

    const content = await readFile(file, 'utf-8');
    const { meta, body } = parseFrontmatter(content);
    const title = extractTitle(body) || relPath;
    const text = `${title}\n${body.slice(0, MAX_TEXT_LENGTH)}`;

    const embedding = await embed(text);

    notes[relPath] = { title, tags: meta.tags || [], embedding };
    mtimes[relPath] = mtime;
    updated++;

    const total = updated + skipped;
    process.stdout.write(`\r  [${wsId}] ${total}/${files.length} (${updated} updated)  `);
  }

  // Remove entries for deleted files
  const fileSet = new Set(files.map(f => relative(wsDir, f)));
  for (const key of Object.keys(notes)) {
    if (!fileSet.has(key)) {
      delete notes[key];
      delete mtimes[key];
    }
  }

  await writeFile(outputFile, JSON.stringify({ notes, mtimes }, null, 2));
  process.stdout.write(`\r  [${wsId}] ${updated} updated, ${skipped} skipped (${files.length} total)\n`);
}

// ── CLI ───────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const allFlag = args.includes('--all');
  const wsIdx = args.indexOf('--workspace');
  const wsId = wsIdx >= 0 ? args[wsIdx + 1] : null;

  if (!allFlag && !wsId) {
    console.log('Usage:');
    console.log('  node indexer.js --workspace <wsId>   index a single workspace');
    console.log('  node indexer.js --all                index all workspaces');
    process.exit(0);
  }

  if (allFlag) {
    console.log('Indexing all workspaces...');
    // Workspaces are 5 levels deep: data/{s0}/{s1}/{s2}/{s3}/{wsId}/
    // Use find to discover actual workspace dirs (contain SOUL.md or CLAUDE.md)
    let wsDirs;
    try {
      const { execSync } = await import('node:child_process');
      const result = execSync(
        `find "${WORKSPACES_DIR}" -mindepth 5 -maxdepth 5 -type d 2>/dev/null`,
        { encoding: 'utf-8', timeout: 30000 }
      ).trim();
      wsDirs = result ? result.split('\n').filter(Boolean) : [];
    } catch {
      console.log('No workspaces directory found.');
      return;
    }

    if (wsDirs.length === 0) {
      console.log('No workspace directories found.');
      return;
    }

    for (const wsDir of wsDirs) {
      await indexWorkspace(wsDir);
    }
    console.log(`Done — ${wsDirs.length} workspace(s) indexed`);
  } else {
    // wsId may be a full shard path (9a/4e/9f/26/9a4e9f263e2fd88a) or bare wsId
    // Try bare wsId via find first, then fall back to direct join
    let wsDir = join(WORKSPACES_DIR, wsId);
    if (!existsSync(wsDir)) {
      try {
        const { execSync } = await import('node:child_process');
        const found = execSync(
          `find "${WORKSPACES_DIR}" -mindepth 5 -maxdepth 5 -type d -name "${wsId}" 2>/dev/null`,
          { encoding: 'utf-8', timeout: 10000 }
        ).trim();
        if (found) wsDir = found.split('\n')[0];
      } catch { /* fall through */ }
    }
    if (!existsSync(wsDir)) {
      console.error(`Workspace not found: ${wsId}`);
      process.exit(1);
    }
    console.log(`Indexing workspace: ${wsId}`);
    await indexWorkspace(wsDir);
    console.log('Done');
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
