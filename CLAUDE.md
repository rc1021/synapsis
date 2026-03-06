# CLAUDE.md — synapsis

## What is this

**Synapsis** — an AI companion that grows with you.

A multi-channel AI system that connects to you through Discord (planned: Telegram/WhatsApp), remembers your conversations, learns your interests, and proactively explores the world alongside you. Powered by a provider-agnostic backend (Claude CLI, Claude API, extensible to Gemini, Codex, Copilot, etc.).

Every conversation is a synapse firing — the more we talk, the smarter we both get.

## Tech stack

- **Runtime:** Node.js v22+ (CommonJS)
- **Dependencies:** discord.js v14, dotenv, node-cron, uuid
- **AI integration:** Provider-agnostic — supports Claude CLI (subscription), Claude API (pay-per-token), extensible to Gemini CLI, Codex, Copilot, etc.
- **Service:** macOS launchd (managed via `app/ctl.sh`)

## Project structure

```
app/
├── src/index.js              # Entry point — orchestrates all channels
├── bridges/
│   ├── shared/               # Shared modules
│   │   ├── providers/        # AI provider abstraction layer
│   │   │   ├── base.js       # BaseProvider class + StreamHandle (EventEmitter)
│   │   │   ├── registry.js   # Provider registry + factory (lazy init)
│   │   │   ├── claude-cli.js # Claude CLI provider (spawn, sandbox, stream-json)
│   │   │   └── claude-api.js # Claude API provider (@anthropic-ai/sdk)
│   │   ├── runner.js         # Shared runner (concurrency queue, timeout, security monitor)
│   │   ├── claude-spawner.js # Backward-compat shim → delegates to claude-cli provider
│   │   ├── logger.js         # Logger factory
│   │   ├── system-prompt.js  # BASE_RULES shared across all channels
│   │   └── security-monitor.js # Tool call violation detector
│   └── discord/src/          # Discord bridge (index, claude-runner, session-store, message-splitter)
├── scheduler/
│   ├── src/                  # Cron scheduler (index, job-runner, state-manager, notifier)
│   └── jobs.json             # Job definitions (cron schedule + config)
├── .env                      # Environment config (tokens, paths, limits)
├── ctl.sh                    # Service control (install/start/stop/restart/status/logs)
└── logs/                     # Auto-rotated log files
```

## How to run

```bash
cd app
npm install
npm start              # or: node src/index.js
```

Service management:
```bash
./app/ctl.sh install   # Install as launchd service + start
./app/ctl.sh restart   # Restart
./app/ctl.sh logs      # Tail live logs
./app/ctl.sh status    # Check if running
```

## Key config (app/.env)

- `DISCORD_TOKEN` — Bot token
- `CLAUDE_PATH` — Path to claude binary (for claude-cli provider)
- `SEED_USER` — bridge:userId for initial workspace migration
- `SESSION_TTL_MINUTES` — Session expiration (default: 60)
- `MAX_CONCURRENCY` — Max parallel AI processes (default: 3)
- `CLAUDE_TIMEOUT` — Hard timeout in ms (default: 300000)
- `AI_PROVIDER` — AI backend: `claude-cli` (default) | `claude-api`
- `ANTHROPIC_API_KEY` — Required when `AI_PROVIDER=claude-api`

## Architecture patterns

- **Provider abstraction:** `bridges/shared/providers/` — each provider implements `run()` (simple) and `runStream()` (streaming EventEmitter). Registry resolves provider by `AI_PROVIDER` env var.
- **Channel interface:** Each bridge exports `{ name, start, cleanup }`. Bridge-specific rules (e.g. `DISCORD_RULES`) are passed to the shared runner.
- **Shared runner:** `bridges/shared/runner.js` — per-workspace serialized concurrency queue, idle/hard-cap timeout, security monitoring, progress callbacks. Used by all bridges.
- **Session management:** Per-user/thread sessions with TTL, token tracking, auto-compaction at 80K tokens
- **Concurrency:** Per-workspace serialization + global concurrency gate (`MAX_CONCURRENCY`)
- **Security:** Workspace isolation (sandbox-exec on macOS, firejail on Linux), token/secret sanitization, security-monitor for tool call violations, prompt injection prevention via `BASE_RULES`

## Coding conventions

- CommonJS (`require`/`module.exports`), no TypeScript
- Use `bridges/shared/logger.js` (`createLogger`) for logging, not `console.log`
- Use provider registry (`bridges/shared/providers/registry.js`) for AI interactions, not direct CLI spawning
- `bridges/shared/claude-spawner.js` is a backward-compat shim — new code should use the provider layer
- Environment loaded once in `app/src/index.js` via dotenv
- Apply `BASE_RULES` system prompt to all channels
- Sanitize all output (redact tokens, .env contents, infrastructure paths)

## Adding a new AI provider

1. Create `bridges/shared/providers/xxx.js` — extend `BaseProvider`, implement `run()` + `runStream()`
2. Register in `providers/registry.js`: `register('xxx', () => new XxxProvider())`
3. Set `AI_PROVIDER=xxx` in `.env`

## Scheduler jobs

Defined in `app/scheduler/jobs.json`. Three types:
- `shell` — runs a bash command (supports `{{TIMESTAMP}}` template)
- `ai` — runs an AI prompt with model/tools/budget config (provider determined by `AI_PROVIDER`)
- `claude` — legacy alias for `ai` (backward compatible)

Job config uses `job.ai` key (or legacy `job.claude` key as fallback).

Features: cron schedule, quiet hours, one-time jobs, Discord notifications, hot reload (auto-detects changes every 5s).

## Important notes

- Each user has their own workspace under `app/workspaces/data/` — bot code should not modify workspaces directly
- Each workspace has its own `CLAUDE.md` with agent-specific instructions (identity, memory, safety rules)
- `SPEC.md` at repo root contains the spec for adding Telegram/WhatsApp bridges
- No test suite currently exists
