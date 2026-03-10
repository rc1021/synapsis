# Synapsis

[English](#) | [繁體中文](README.zh-TW.md) | [日本語](README.ja.md) | [한국어](README.ko.md)

> **Experimental project — not for production or commercial use.**
>
> This software is provided as-is for learning and personal experimentation only. The author assumes no responsibility or liability for any damages, costs, or issues arising from using, modifying, or deploying this project. By using Synapsis, you agree that you do so entirely at your own risk. You are solely responsible for complying with all applicable terms of service of third-party APIs and platforms (including but not limited to Anthropic, Discord, Google, and OpenAI).
>
> See [LICENSE](LICENSE) for full terms.

An AI companion that grows with you.

Every conversation is a synapse firing — the more we talk, the smarter we both get.

## What it does

Synapsis gives your AI a persistent identity, memory, and the ability to reach out on its own. It's not a chatbot — it's a companion that lives alongside you across messaging platforms.

- **Remembers you** — each user gets a private workspace with memory, notes, and knowledge seeds that persist across conversations
- **Grows with you** — automatically explores topics you care about, waters knowledge seeds, and shares discoveries
- **Reaches out** — proactive check-ins, idle nudges, and onboarding conversations that feel like a real friend, not a notification
- **Multi-channel** — Discord today, Telegram and WhatsApp planned
- **Provider-agnostic** — swap AI backends with one env var: Claude API (default), extensible to Gemini API, OpenAI API, and more
- **Multi-user** — each person gets their own sandboxed workspace with independent memory, seeds, and identity

## How it works

```
You ←→ Discord (bridge) ←→ Shared Runner ←→ AI Provider (API)
                                 ↕
                          Your Workspace
                     ┌─────────────────────┐
                     │ CLAUDE.md  USER.md   │
                     │ SOUL.md    SEEDS.md  │
                     │ MEMORY.md  memory/   │
                     └─────────────────────┘
```

When you message the bot, the bridge routes it through a shared runner to the AI provider. The AI reads your workspace files for context, responds, and updates your memory. Scheduled jobs (engagement system) run in the background, deepening the relationship over time.

## Getting started

Prerequisites: **Node.js v22+** ([nodejs.org](https://nodejs.org))

Before you begin, prepare:
1. An **Anthropic API key** — get from [console.anthropic.com](https://console.anthropic.com/)
2. A **Discord bot token** — create at [Discord Developer Portal](https://discord.com/developers/applications) (enable **Message Content Intent** under Bot → Privileged Gateway Intents)

Then run:

```bash
curl -fsSL https://raw.githubusercontent.com/rc1021/synapsis/refs/heads/main/install.sh | bash
```

The installer will download the latest release, install dependencies, ask for your API key and Discord token, and start the service automatically.

The installer adds the `synapsis` command to your PATH. Restart your shell or run `source ~/.zshrc` to use it.

Once running, send a DM to your bot — if it replies, you're all set!

### Service management

```bash
synapsis status    # check if running
synapsis logs      # tail live logs
synapsis restart   # restart service
synapsis stop      # stop service
synapsis update    # update to latest version
synapsis version   # show current version
synapsis setup     # reconfigure API keys / tokens
synapsis uninstall # completely remove synapsis
```

### Usage guide

#### Discord

**For the bot owner (first-time setup):**

1. Create a Discord server (or use an existing one)
2. Invite your bot to the server via the [Discord Developer Portal](https://discord.com/developers/applications) OAuth2 URL
3. The owner's workspace is created automatically on first message (configured via `SEED_USER` in `.env`)
4. Start chatting with the bot via DM — it will introduce itself and get to know you

**Inviting friends:**

1. Run `/share-code` in Discord — you'll get two things:
   - A **Synapsis invite code** (24hr, one-time use)
   - A **server invite link** (24hr, one-time use)
2. Send both to your friend
3. Your friend clicks the server invite link to join the server
4. They'll receive an automatic welcome DM from the bot
5. They run `/connection <invite-code>` to register and get their own workspace
6. Done! They can now chat with the bot via DM

**Cross-platform account binding:**

If a user wants to use the same workspace from another platform (e.g. future Telegram bridge):

1. On the registered account, run `/bind-token` — get a 5-min one-time token
2. On the other platform, run `/bind <token>`
3. Both accounts now share the same workspace, memory, and identity

**Commands:**

| Command | Description |
|---------|-------------|
| `/help` | Show available commands |
| `/new` or `/reset` | Start a new conversation (clear current session) |
| `/dashboard` | Open workspace file manager (web UI) |
| `/todo` | List your todos |
| `/todo <item>` | Add a todo item |
| `/yt <url>` | YouTube transcript analysis |
| `/yt <url> verify:true` | Transcript + fact-check & explore |
| `/connection <code>` | Register with an invite code |
| `/share-code` | Generate invite code + server invite link |
| `/bind-token` | Generate a cross-platform binding token |
| `/bind <token>` | Bind this account to an existing workspace |

> All command descriptions are localized — they appear in your Discord language (English, 繁體中文, 简体中文, 日本語, 한국어).

#### Telegram (planned)

Not yet available. Will support `/command` style interactions similar to Discord.

#### WhatsApp (planned)

Not yet available. WhatsApp has no slash command system, so interactions will use natural language or keyword triggers (e.g. send `HELP` to see available actions).

## Configuration

All config lives in `app/.env`:

| Variable | Description | Default |
|----------|-------------|---------|
| `DISCORD_TOKEN` | Discord bot token (required) | — |
| `AI_PROVIDER` | AI backend (see provider list below) | `claude-api` |
| `ANTHROPIC_API_KEY` | Anthropic API key (required for `claude-api`) | — |
| `MAX_CONCURRENCY` | Max parallel AI processes | `3` |
| `CLAUDE_TIMEOUT` | Hard timeout per request (ms) | `300000` (5 min) |
| `SESSION_TTL_MINUTES` | Session expiration | `60` |
| `COMPACT_THRESHOLD` | Token count before session rotation | `80000` |
| `SECURITY_ADMIN_ID` | Discord user ID for security alerts | — |
| `WEB_PORT` | Web dashboard port (set to enable) | — |
| `WEB_PUBLIC_URL` | Public URL for ngrok/tunnel | — |
| `NGROK_DOMAIN` | ngrok domain (auto-managed by `ctl.sh`) | — |

## Architecture

```
app/
├── bridges/
│   ├── shared/
│   │   ├── providers/        # AI provider abstraction
│   │   │   ├── base.js       # BaseProvider + StreamHandle (EventEmitter)
│   │   │   ├── registry.js   # Provider registry (lazy init factory)
│   │   │   └── claude-api.js # Claude API provider (@anthropic-ai/sdk)
│   │   ├── runner.js         # Shared runner (per-workspace queue, timeout, security)
│   │   ├── workspace-manager.js  # Multi-workspace CRUD, binding, indexing
│   │   └── security-monitor.js   # Tool call violation detector
│   ├── discord/              # Discord bridge
│   └── web/                  # Web dashboard (file browser, auth)
├── scheduler/
│   ├── common-jobs.json      # Engagement job definitions
│   ├── jobs.json             # System maintenance jobs
│   └── src/
│       ├── job-runner.js     # Shell + AI job executor
│       └── user-job-scheduler.js  # Per-user event-driven scheduler
├── workspace-template/       # Template for new user workspaces
└── workspaces/data/          # Per-user sandboxed workspaces
```

### Adding a new provider

The provider layer supports any AI backend that offers an API. Create `providers/xxx.js`, extend `BaseProvider`, implement `run()` + `runStream()`, register in `registry.js`.

Currently supported:

| Provider | `AI_PROVIDER` | Required env | Status |
|----------|---------------|-------------|--------|
| Anthropic (Claude) | `claude-api` | `ANTHROPIC_API_KEY` | Default |
| Gemini | `gemini-api` | `GOOGLE_API_KEY` | Planned |
| OpenAI | `openai-api` | `OPENAI_API_KEY` | Planned |

> **Note on CLI-based providers:**
> Some AI services also offer CLI tools (e.g. Claude CLI, Gemini CLI, Codex CLI). Synapsis includes experimental support for CLI-based providers, which can be useful for personal development and testing. CLI providers are subject to each vendor's terms of service — most CLI tools are licensed for individual use only and may not be suitable for multi-user deployments. If you want to use a CLI provider, set `AI_PROVIDER` to the corresponding CLI provider name (e.g. `claude-cli`) and ensure the CLI tool is installed and authenticated on your machine.

### Engagement system

14 event-driven jobs that fire based on user activity — not cron timers. Key examples:

| Job | Trigger | What it does |
|-----|---------|-------------|
| Onboarding | USER.md has blank fields | Naturally gets to know new users through conversation |
| Feature intro | After onboarding completes | Introduces workspace features (one-time) |
| Seed watering | 30+ chat lines accumulated | Deep-dives into topics from conversations, creates knowledge notes |
| Proactive check-in | Daily, if user was active in last 7 days | Casual message referencing recent context |
| Idle check-in | 3 days since last message | Gentle nudge without guilt-tripping |
| Discovery | Every 5 days | Searches for news/articles matching user interests |
| Style calibration | After enough talk history | Learns the user's communication style |
| Weekly synthesis | Weekly | Summarizes the week's conversations and growth |
| Memory consolidation | Periodic | Distills daily notes into long-term memory |
| Self-tune | Periodic | Adjusts interaction frequency based on engagement |

All jobs respect **quiet hours** — no notifications during sleep.

#### Per-workspace cron jobs

Users can ask the AI to set reminders or scheduled tasks. The AI writes these to the workspace's `jobs.json`:

```json
{
  "id": "milk-reminder",
  "name": "免費牛奶提醒",
  "schedule": "30 17 * * *",
  "tier": "quick",
  "notify": { "when": "always" },
  "prompt": "🥛 記得去拿免費牛奶！"
}
```

- **`notify`** — controls output delivery: `always` (send every time), `not_match` (send unless output contains a marker), `error` (only on failure). Defaults to `always` if omitted.
- **`once: true`** — one-time jobs are automatically disabled after execution.

### Soul evolution

The shared soul (`app/SOUL.md`) is not static — it self-evolves through three system-level jobs:

| Job | Schedule | What it does |
|-----|----------|-------------|
| Self-reflection | Weekly | Reads all per-workspace `SOUL.md` files, extracts abstract patterns, identifies tensions |
| Autonomous exploration | Twice/week | Explores the soul's own interests via web search, forms independent opinions |
| Tension resolution | Monthly | Reviews conflicts between shared and per-workspace souls — refine, reaffirm, or defer |

Privacy: reflection jobs only read per-workspace `SOUL.md` — never user data.

### Workspace structure

Each user gets a private, sandboxed workspace:

```
workspaces/data/<user-id>/
├── CLAUDE.md      # Agent instructions (living operations manual)
├── USER.md        # About the human (name, language, interests, AI naming)
├── SOUL.md        # Agent personality and values (self-evolving)
├── SEEDS.md       # Knowledge seeds — topics to explore
├── MEMORY.md      # Long-term curated memory
└── memory/        # Daily notes (YYYY-MM-DD.md)
```

### Security

6-layer defense for multi-user sandboxed workspaces:

1. **OS-level sandbox** — macOS `sandbox-exec` / Linux `firejail` restricts filesystem + network
2. **Permission flags** — restrictive permissions only inside sandbox
3. **Tool whitelist** — limited set of allowed tools per workspace
4. **System prompt rules** — `BASE_RULES` enforced across all channels
5. **Sync prompt injection guard** — `SYNC_PROMPT.md` prevents workspace escape
6. **Runtime security monitor** — detects and alerts on tool call violations

See [SECURITY.md](SECURITY.md) for the full threat model and architecture.

## Contributing

```bash
git clone https://github.com/rc1021/synapsis.git
cd synapsis/app
cp .env.example .env
npm install
npm start
```

Key conventions:
- CommonJS (`require`/`module.exports`), no TypeScript
- Use `bridges/shared/logger.js` for logging, not `console.log`
- Use provider registry for AI calls
- Environment loaded once in `app/src/index.js` via dotenv

## License

MIT — see [LICENSE](LICENSE)
