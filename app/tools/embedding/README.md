# embedding-tools

Semantic search for learning notes (`memory/learning/`). Builds a local vector index and queries it using cosine similarity — no external API calls.

## Tech Stack

- Node.js (ESM)
- [@xenova/transformers](https://github.com/xenova/transformers.js) — runs ONNX models locally
- Model: `all-MiniLM-L6-v2` (384-dim embeddings, ~80MB on first download)

## Install

```bash
cd app/tools/embedding
npm install
```

The model is downloaded and cached automatically on first run.

## Usage

### 1. Build the index

```bash
node index.js
```

Scans `memory/learning/` recursively for `.md` files (skips `sources.md` and `series-index.md`). For each note it:

- Parses YAML frontmatter for `series` and `tags`
- Extracts the first `# heading` as title
- Embeds `title + first 500 chars of body`
- Writes everything to `memory/learning/embeddings.json`

Re-run after adding or editing notes to update the index.

### 2. Search

**Text query:**

```bash
node search.js "穩定幣結算"
```

**Find similar notes:**

```bash
node search.js --note 2026/03/2026-03-04-13.md
```

**Change result count (default 5):**

```bash
node search.js --top 10 "跨境匯款"
```

### CLI flags

| Flag | Description | Default |
|------|-------------|---------|
| `--top N` | Number of results to return | `5` |
| `--note KEY` | Find notes similar to an existing note (by relative path inside `memory/learning/`) | — |

When using `--note`, the model is not loaded — similarity is computed directly from stored embeddings, so it's instant.

## Output format

`embeddings.json` structure:

```json
{
  "notes": {
    "2026/02/2026-02-28-18.md": {
      "title": "學習筆記｜跨境匯款：全球結構、灰色管道與穩定幣趨勢",
      "series": "移工匯款市場深度研究",
      "tags": ["remittance", "global-overview", "stablecoin"],
      "embedding": [0.034, -0.029, ...]
    }
  }
}
```

Each embedding is a 384-dimensional float array.

## Notes on Chinese queries

`all-MiniLM-L6-v2` is trained primarily on English. It handles Chinese text but with lower precision — mixed Chinese/English queries or English keywords often return better results than pure Chinese. For best results, try both languages.

## Project structure

```
app/tools/embedding/
├── index.js          # Indexer — builds embeddings.json
├── search.js         # Searcher — query by text or note
├── lib/
│   └── similarity.js # Cosine similarity + top-N ranking
└── package.json
```
