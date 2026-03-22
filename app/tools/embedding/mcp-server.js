#!/usr/bin/env node

/**
 * Memory MCP Server — per-workspace semantic search over embeddings.json.
 *
 * Protocol: JSON-RPC 2.0 over stdio (newline-delimited).
 * Env:
 *   WORKSPACE_DIR — absolute path to the workspace directory
 *
 * Tools exposed:
 *   memory_search(query, top_n?) → [{ score, title, path }]
 */

import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { embed } from './lib/embedder.js';
import { findTopSimilar } from './lib/similarity.js';

const WORKSPACE_DIR = process.env.WORKSPACE_DIR;

if (!WORKSPACE_DIR) {
  process.stderr.write('[memory-mcp] WORKSPACE_DIR env var is required\n');
  process.exit(1);
}

const INDEX_FILE = join(WORKSPACE_DIR, 'embeddings.json');

// Lazy-loaded index cache
let indexCache = null;

async function loadIndex() {
  if (indexCache) return indexCache;
  try {
    const raw = await readFile(INDEX_FILE, 'utf-8');
    indexCache = JSON.parse(raw);
  } catch {
    indexCache = { notes: {} };
  }
  return indexCache;
}

// ── JSON-RPC helpers ──────────────────────────────────────────────────────────

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function sendResult(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

// ── Tool definitions ──────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'memory_search',
    description:
      'Semantically search this workspace\'s memory and notes for relevant content. ' +
      'Returns the most similar documents ranked by relevance. ' +
      'Use when the user references past topics, asks about what they\'ve discussed before, ' +
      'or when context from previous notes would enrich the response.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Natural language search query',
        },
        top_n: {
          type: 'number',
          description: 'Number of results to return (default: 5)',
        },
      },
      required: ['query'],
    },
  },
];

// ── Request handlers ──────────────────────────────────────────────────────────

async function handleMemorySearch(id, { query, top_n = 5 } = {}) {
  if (!query || typeof query !== 'string') {
    sendError(id, -32602, 'query is required and must be a string');
    return;
  }

  const index = await loadIndex();
  const entries = Object.entries(index.notes || {}).map(([key, val]) => ({ key, ...val }));

  if (entries.length === 0) {
    sendResult(id, { content: [{ type: 'text', text: '[]' }] });
    return;
  }

  const queryEmbedding = await embed(query);
  const results = findTopSimilar(queryEmbedding, entries, Math.min(top_n, 20));

  const output = results.map(r => ({
    score: parseFloat(r.score.toFixed(3)),
    title: index.notes[r.key]?.title || r.key,
    path: r.key,
  }));

  sendResult(id, { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }] });
}

async function handleRequest(req) {
  const { id, method, params } = req;

  switch (method) {
    case 'initialize':
      sendResult(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'memory', version: '1.0.0' },
      });
      break;

    case 'notifications/initialized':
      // No response needed for notifications
      break;

    case 'ping':
      sendResult(id, {});
      break;

    case 'tools/list':
      sendResult(id, { tools: TOOLS });
      break;

    case 'tools/call':
      if (params?.name === 'memory_search') {
        await handleMemorySearch(id, params.arguments);
      } else {
        sendError(id, -32602, `Unknown tool: ${params?.name}`);
      }
      break;

    default:
      if (id !== undefined && id !== null) {
        sendError(id, -32601, `Method not found: ${method}`);
      }
  }
}

// ── Main loop ─────────────────────────────────────────────────────────────────

const rl = createInterface({ input: process.stdin, terminal: false });

rl.on('line', async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let req;
  try {
    req = JSON.parse(trimmed);
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }

  try {
    await handleRequest(req);
  } catch (err) {
    process.stderr.write(`[memory-mcp] Error handling ${req.method}: ${err.message}\n`);
    if (req.id !== undefined && req.id !== null) {
      sendError(req.id, -32603, `Internal error: ${err.message}`);
    }
  }
});

rl.on('close', () => process.exit(0));
