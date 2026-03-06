# Synapsis

An AI companion that grows with you.

Every conversation is a synapse firing — the more we talk, the smarter we both get.

## What it does

Synapsis connects an AI to your messaging platforms and builds a living relationship over time:

- **Remembers you** — persistent workspace with memory, notes, and knowledge seeds
- **Grows with you** — automatically explores topics you care about, waters knowledge seeds, shares discoveries
- **Reaches out** — proactive check-ins, idle nudges, and onboarding conversations that feel natural
- **Multi-channel** — Discord today, Telegram and WhatsApp planned
- **Provider-agnostic** — Claude CLI, Claude API, extensible to Gemini, Codex, Copilot, and more

## Quick start

```bash
cd app
cp .env.example .env   # fill in DISCORD_TOKEN, CLAUDE_PATH, etc.
npm install
npm start
```

## Architecture

```
app/
├── bridges/
│   ├── shared/
│   │   ├── providers/     # AI provider abstraction (claude-cli, claude-api, ...)
│   │   └── runner.js      # Shared runner (concurrency, timeout, security)
│   └── discord/           # Discord bridge
├── scheduler/             # Cron + event-driven job system
│   ├── common-jobs.json   # Proactive engagement jobs
│   └── jobs.json          # System maintenance jobs
└── workspaces/            # Per-user sandboxed workspaces
    └── data/              # Each user gets: CLAUDE.md, USER.md, SEEDS.md, memory/, ...
```

### Provider layer

Switch AI backends with one env var:

```bash
AI_PROVIDER=claude-cli    # Local Claude CLI (subscription)
AI_PROVIDER=claude-api    # Anthropic API (pay-per-token)
```

Adding a new provider: create `providers/xxx.js`, extend `BaseProvider`, register in `registry.js`.

### Engagement system

Event-driven jobs that fire based on user activity:

| Job | Trigger | What it does |
|-----|---------|-------------|
| Seed watering | 30+ chat lines | Deep-dives into topics from conversations |
| Proactive check-in | Daily, if active | Casual message referencing recent context |
| Idle check-in | 3 days inactive | Gentle nudge without guilt-tripping |
| Discovery | Every 5 days | Searches for news/articles matching user interests |
| Onboarding | USER.md incomplete | Naturally gets to know new users |

### Security

6-layer defense for multi-user sandboxed workspaces:

1. OS-level sandbox (macOS sandbox-exec / Linux firejail)
2. CLI permission flags
3. Tool whitelist
4. System prompt rules
5. Sync prompt injection
6. Runtime security monitor

## License

MIT
