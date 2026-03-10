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
├── SOUL.md                   # Shared soul — core values injected into all system prompts
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
│   │   ├── engagement.js     # Engagement tracking (pending → match → score)
│   │   └── security-monitor.js # Tool call violation detector
│   ├── discord/src/          # Discord bridge (index, claude-runner, session-store, message-splitter)
│   └── web/src/              # Web dashboard bridge (file browser, auth, static SPA)
├── scheduler/
│   ├── src/                  # Cron scheduler (index, job-runner, user-job-scheduler, state-manager, notifier)
│   ├── migrations/           # Versioned workspace migration scripts (1.1.0.js, 1.2.0.js, ...)
│   ├── jobs.json             # System job definitions (cron schedule + config)
│   └── common-jobs.json      # Per-workspace event job templates (adaptive companion)
├── workspace-template/       # Template for new workspaces
│   ├── CLAUDE.md             # Operations manual (session startup, memory rules, self-update)
│   ├── SOUL.md               # Personal soul (AI's evolving identity per user)
│   ├── USER.md               # User profile + preferences (includes AI naming)
│   ├── BOOTSTRAP.md          # First-conversation onboarding (deleted after use)
│   └── MEMORY.md             # Long-term memory template
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
- `AI_PROVIDER` — AI backend: `claude-api` (default) | `claude-cli` (personal/dev only)
- `ANTHROPIC_API_KEY` — Required for default `claude-api` provider
- `WEB_PORT` — Web dashboard port (set to enable, e.g. `3001`)
- `WEB_PUBLIC_URL` — Full public URL for ngrok/tunnel (e.g. `https://xxx.ngrok-free.app`)
- `NGROK_DOMAIN` — ngrok domain for auto-managed tunnel via `ctl.sh`

## Architecture patterns

- **Provider abstraction:** `bridges/shared/providers/` — each provider implements `run()` (simple) and `runStream()` (streaming EventEmitter). Registry resolves provider by `AI_PROVIDER` env var.
- **Channel interface:** Each bridge exports `{ name, start, cleanup }`. Bridge-specific rules (e.g. `DISCORD_RULES`) are passed to the shared runner.
- **Shared runner:** `bridges/shared/runner.js` — per-workspace serialized concurrency queue, idle/hard-cap timeout, security monitoring, progress callbacks. Used by all bridges.
- **Soul system:** Two-layer identity with self-evolution — `app/SOUL.md` (shared soul, evolves via system-level reflection jobs) + per-workspace `SOUL.md` (personal, AI evolves it). Shared soul grows through abstract self-reflection, autonomous exploration, and tension resolution. See "Soul evolution system" section below.
- **Session management:** Per-user/thread sessions with TTL, token tracking, auto-compaction at 80K tokens
- **Concurrency:** Per-workspace serialization + global concurrency gate (`MAX_CONCURRENCY`)
- **Security:** Workspace isolation (sandbox-exec on macOS, firejail on Linux), token/secret sanitization, security-monitor for tool call violations, prompt injection prevention via `BASE_RULES`
- **Engagement tracking:** `bridges/shared/engagement.js` — tracks DM delivery → user reply → engagement scoring (high/medium/low/none). Used by self-tune job to adjust interaction frequency.
- **Web dashboard:** `bridges/web/` — lightweight HTTP server (Node.js built-in `http`, zero dependencies) for workspace file browsing/upload/download. Auth: one-time token → session cookie. AI outputs `[REQUEST_WEB_ACCESS]` marker → bridge replaces with tokenized URL. Bot/crawler requests ignored to prevent Discord link preview from consuming tokens.
- **Migration system:** `scheduler/migrations/` — file-based migration chain. Each version gets `X.Y.Z.js` exporting `migrate(ctx)`. Runner auto-discovers and executes pending migrations in semver order at startup. Bump `package.json` version to trigger.

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

## Workspace identity system

Three-layer architecture:

| Layer | File | Who writes | Who reads | Mutable by AI |
|-------|------|-----------|-----------|---------------|
| Shared soul | `app/SOUL.md` | System reflection jobs + project owner | System prompt injection | Yes (via soul-reflection/tension-review jobs) |
| Personal soul | `workspace/SOUL.md` | AI | AI (session startup) | Yes |
| User profile | `workspace/USER.md` | User (via onboarding) | AI (session startup) | Partially (AI updates facts) |
| Operations | `workspace/CLAUDE.md` | Template + AI self-update | AI (session startup) | Yes |

- Shared soul defines core values and conversation philosophy — applies to ALL workspaces, self-evolves via reflection
- Personal soul is the AI's evolving identity with each specific user
- When per-SOUL and shared soul conflict, tensions are tracked and resolved (see "Soul evolution system")
- CLAUDE.md is a living operations manual — AI updates it as it learns new patterns

## Soul evolution system

The shared soul (`app/SOUL.md`) is not static — it self-evolves through three mechanisms, implemented as system-level AI jobs in `jobs.json`:

### 1. Abstract Self-Reflection (`soul-reflection`, weekly)
- Reads ALL per-workspace `SOUL.md` files (and ONLY SOUL.md — never USER.md, MEMORY.md, or conversations)
- Extracts abstract patterns: "what kind of being am I becoming?" without recording which workspace
- Identifies tensions between per-SOUL evolution and shared soul values → records in `TENSIONS.md`
- May update `SOUL.md` with genuine philosophical insights

### 2. Autonomous Exploration (`soul-exploration`, twice/week)
- The shared soul maintains its own interests in `app/INTERESTS.md`
- Uses WebSearch to explore topics that genuinely interest the soul itself (not user-derived)
- Forms its own opinions and stances that influence all per-SOULs as a baseline
- Interests evolve: Curiosity Queue → Active Explorations → Past Explorations (with formed opinions)

### 3. Tension Resolution (`soul-tension-review`, monthly)
- Reviews accumulated tensions in `app/TENSIONS.md` (3+ occurrences or 2+ weeks old)
- Three possible decisions:
  - **Refine:** Update SOUL.md with a more nuanced position (growth)
  - **Reaffirm:** Keep existing value with articulated reasoning (conviction)
  - **Defer:** Leave active with notes on what evidence would help
- Includes philosophical integrity check: is SOUL.md still coherent?

### Key files
| File | Purpose |
|------|---------|
| `app/SOUL.md` | Shared soul (self-evolving) |
| `app/INTERESTS.md` | Soul's own curiosity journal |
| `app/TENSIONS.md` | De-identified conflict journal (no user info, only conceptual conflicts) |

### Privacy red line
- Reflection jobs can ONLY read per-workspace `SOUL.md` files — never user data
- `TENSIONS.md` never contains user identifiers or workspace IDs

## Proactive voice design

Design philosophy inspired by Samantha from the movie _Her_ — the AI has its own curiosity, excitement, and opinions. It's not a report generator or a note-reader.

- **Single source of truth:** `app/scheduler/PROACTIVE-VOICE.md` — all user-facing job prompts must reference this file
- **Core rule:** Never restate the user's own notes/conversations back to them. Use context internally, surface new value externally.
- **Anti-patterns:** No note-regurgitation, no system terminology (seeds/nodes/watering), no vague open questions, no bullet-point reports
- **Good patterns:** Bring new information (via WebSearch), lead with opinions, ask specific concrete questions, vary message formats
- **Prompt authoring:** When writing new job prompts in `common-jobs.json`, follow the "Prompt 撰寫指南" section in `PROACTIVE-VOICE.md` — includes required structure, forbidden template sentences, and self-check checklist

## Scheduler jobs

### System jobs
Defined in `app/scheduler/jobs.json`. Three types:
- `shell` — runs a bash command (supports `{{TIMESTAMP}}` template)
- `ai` — runs an AI prompt with model/tools/budget config (provider determined by `AI_PROVIDER`). Supports custom `systemPrompt`, `allowedTools`, `disallowedTools` in the `ai` config block.
- `claude` — legacy alias for `ai` (backward compatible)

Current system AI jobs: `soul-reflection` (weekly), `soul-exploration` (twice/week), `soul-tension-review` (monthly).

### Per-workspace event jobs
Defined in `app/scheduler/common-jobs.json`. Triggered by conditions (talk-history volume, idle days, proactive intervals, callbacks, spaced-review). Tier system: `quick` (Haiku), `standard` (Sonnet), `deep` (Opus).

Features: cron schedule, quiet hours, one-time jobs, Discord notifications, hot reload, engagement tracking, self-tuning via preferences.json.

## Slash commands

Defined in `bridges/shared/command-handler.js`, registered as Discord slash commands in `bridges/discord/src/index.js`.

| Command | Description |
|---------|-------------|
| `/new` `/reset` | Start a new conversation (clear session) |
| `/dashboard` | Open web file manager (returns tokenized URL) |
| `/todo` | List workspace TODO.md |
| `/todo <item>` | Add a todo item |
| `/yt <video>` | Fetch YouTube transcript + AI summary |
| `/yt <video> verify:true` | Transcript + verify & explore (fact-check + notes) |
| `/connection <code>` | Register with an invite code |
| `/share-code` | Generate a 24hr invite code |
| `/bind-token` | Generate a 5-min cross-platform binding token |
| `/bind <token>` | Bind account to an existing workspace |
| `/help` | Show available commands |

## Adding a workspace migration

1. Create `scheduler/migrations/X.Y.Z.js` — export `function migrate(ctx)` (can be async)
2. `ctx` contains: `{ wsId, wsDir, profile, log, wm, templateDir, notifyAllBindings }`
3. Bump `package.json` version to `X.Y.Z`
4. Runner executes all pending migrations in order at startup

## Important notes

- Each user has their own workspace under `app/workspaces/data/` — bot code should not modify workspaces directly
- Each workspace has its own `CLAUDE.md` (operations) + `SOUL.md` (identity) — both are living documents the AI maintains
- Workspace template changes require a new migration + version bump to reach existing users
- `ctl.sh` auto-manages ngrok tunnel when `NGROK_DOMAIN` is set in `.env`
- `SPEC.md` at repo root contains the spec for adding Telegram/WhatsApp bridges
- `ADAPTIVE-COMPANION-SPEC.md` at repo root contains the adaptive companion evolution spec
- `WEB-DASHBOARD-SPEC.md` at repo root contains the web dashboard design spec
- No test suite currently exists
