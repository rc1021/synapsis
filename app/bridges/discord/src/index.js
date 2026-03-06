const { Client, GatewayIntentBits, Partials, SlashCommandBuilder, REST, Routes, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { resolve, join } = require('path');
const fs = require('fs');
const SessionStore = require('./session-store');
const { enqueue } = require('./claude-runner');
const { splitMessage } = require('./message-splitter');
const { parseCommand, handleCommand } = require('../../shared/command-handler');
const wm = require('../../shared/workspace-manager');
const { sanitizeOutput, isTextFile, TEXT_EXTENSIONS } = require('../../shared/sanitize');
const log = require('./logger');

const MAX_INPUT = 8000;
const TALK_HISTORY_FILE = 'talk-history.jsonl';
const TALK_HISTORY_MAX_FIELD = 500;
const OUTBOX_DIR = 'outbox';
const MAX_DISCORD_FILE_SIZE = 10 * 1024 * 1024; // 10MB per file

function appendTalkHistory(wsPath, userMsg, assistantMsg) {
  try {
    const filePath = join(wsPath, TALK_HISTORY_FILE);
    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      u: userMsg.slice(0, TALK_HISTORY_MAX_FIELD),
      a: assistantMsg.slice(0, TALK_HISTORY_MAX_FIELD),
    }) + '\n';
    fs.appendFileSync(filePath, entry);
  } catch (err) {
    log.warn(`Failed to append talk-history: ${err.message}`);
  }
}

/**
 * Collect files from workspace outbox/ directory for Discord attachment.
 * Text files are sanitized (workspace paths replaced, leak detection).
 * Returns array of { attachment: Buffer, name: string } and cleans up.
 */
function collectOutbox(wsPath) {
  const outboxPath = join(wsPath, OUTBOX_DIR);
  if (!fs.existsSync(outboxPath)) return [];

  const files = [];
  try {
    for (const name of fs.readdirSync(outboxPath)) {
      const filePath = join(outboxPath, name);
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) continue;
      if (stat.size > MAX_DISCORD_FILE_SIZE) {
        log.warn(`Outbox file "${name}" too large (${(stat.size / 1024 / 1024).toFixed(1)}MB), skipping`);
        continue;
      }
      if (stat.size === 0) continue;

      if (isTextFile(name)) {
        // Text file — sanitize content before sending
        const raw = fs.readFileSync(filePath, 'utf-8');
        const sanitized = sanitizeOutput(raw, wsPath);
        if (!sanitized.safe) {
          log.warn(`[SECURITY] Outbox file "${name}" blocked — infrastructure leak detected`);
          continue;
        }
        files.push({ attachment: Buffer.from(sanitized.text, 'utf-8'), name });
      } else {
        files.push({ attachment: fs.readFileSync(filePath), name });
      }
    }
    // Clean up outbox
    for (const name of fs.readdirSync(outboxPath)) {
      fs.unlinkSync(join(outboxPath, name));
    }
    fs.rmdirSync(outboxPath);
  } catch (err) {
    log.warn(`Failed to collect outbox: ${err.message}`);
  }
  return files;
}

const MAX_ATTACHMENT_SIZE = 20 * 1024 * 1024;
const TYPING_INTERVAL = 8000;

let TOKEN;
let TTL;
let client;

// Per-workspace session stores, lazily created
const sessionStores = new Map(); // wsPath -> SessionStore

function getSessionStore(wsPath) {
  if (!sessionStores.has(wsPath)) {
    const storePath = wm.sessionStorePath(wsPath);
    sessionStores.set(wsPath, new SessionStore(TTL, storePath));
  }
  return sessionStores.get(wsPath);
}

// Dedup
const processedMessages = new Set();
const DEDUP_TTL = 60000;

const slashCommands = [
  new SlashCommandBuilder()
    .setName('new')
    .setDescription('Start a new conversation (clear current session)'),
  new SlashCommandBuilder()
    .setName('reset')
    .setDescription('Clear current session'),
  new SlashCommandBuilder()
    .setName('connection')
    .setDescription('Register with an invite code')
    .addStringOption(opt => opt.setName('code').setDescription('Invite code').setRequired(true)),
  new SlashCommandBuilder()
    .setName('share-code')
    .setDescription('Generate an invite code to share'),
  new SlashCommandBuilder()
    .setName('bind-token')
    .setDescription('Generate a token to bind another bridge account'),
  new SlashCommandBuilder()
    .setName('bind')
    .setDescription('Bind this account to an existing workspace')
    .addStringOption(opt => opt.setName('token').setDescription('Bind token').setRequired(true)),
];

async function fetchReferencedContent(message) {
  if (!message.reference?.messageId) return '';
  try {
    const ref = await message.channel.messages.fetch(message.reference.messageId);
    if (!ref) return '';

    let text = ref.content || '';
    const authorLabel = ref.author.id === message.client.user.id
      ? 'Claude (you)'
      : ref.author.username;

    const attachments = ref.attachments.size > 0
      ? `\n[Attachments: ${ref.attachments.map(a => a.name).join(', ')}]`
      : '';

    const isSelf = ref.author.id === message.client.user.id;
    const MAX_REF = isSelf ? 150 : 500;
    if (text.length > MAX_REF) text = text.slice(0, MAX_REF) + '...[truncated]';
    if (!text && !attachments) return '';

    return `[Replying to ${authorLabel}: "${text}${attachments}"]\n`;
  } catch (err) {
    log.warn(`Failed to fetch referenced message: ${err.message}`);
    return '';
  }
}

async function fetchTextAttachments(message, uploadsDir) {
  if (!message.attachments.size) return '';

  fs.mkdirSync(uploadsDir, { recursive: true });

  const parts = [];
  const savedFiles = [];
  for (const [, att] of message.attachments) {
    const ext = (att.name || '').match(/\.[^.]+$/)?.[0]?.toLowerCase() || '';
    const isText = TEXT_EXTENSIONS.has(ext) || (att.contentType && att.contentType.startsWith('text/'));
    if (!isText) continue;
    if (att.size > MAX_ATTACHMENT_SIZE) {
      parts.push(`[Attachment "${att.name}" skipped: too large (${(att.size / 1024).toFixed(0)}KB, limit ${(MAX_ATTACHMENT_SIZE / 1000).toFixed(0)}KB)]`);
      continue;
    }

    try {
      const res = await fetch(att.url);
      if (!res.ok) {
        parts.push(`[Attachment "${att.name}" fetch failed: ${res.status}]`);
        continue;
      }
      const buffer = Buffer.from(await res.arrayBuffer());
      const safeName = att.name.replace(/[^a-zA-Z0-9._-]/g, '_');
      const fileName = `${message.id}_${safeName}`;
      const filePath = join(uploadsDir, fileName);
      fs.writeFileSync(filePath, buffer);
      savedFiles.push(filePath);

      const sizeKB = (att.size / 1024).toFixed(0);
      parts.push(`[User uploaded file "${att.name}" (${sizeKB}KB) -> saved to uploads/${fileName} -- use the Read tool to read it]`);
      log.info(`Attachment saved: ${filePath} (${sizeKB}KB)`);
    } catch (err) {
      log.warn(`Failed to fetch attachment ${att.name}: ${err.message}`);
      parts.push(`[Attachment "${att.name}" fetch error]`);
    }
  }

  if (savedFiles.length) {
    setTimeout(() => {
      for (const f of savedFiles) {
        fs.unlink(f, (err) => {
          if (err && err.code !== 'ENOENT') log.warn(`Upload cleanup failed: ${f}: ${err.message}`);
          else log.debug(`Upload cleaned up: ${f}`);
        });
      }
    }, 10 * 60 * 1000);
  }

  return parts.length ? '\n\n' + parts.join('\n\n') : '';
}

function setupEventHandlers() {
  client.once('ready', async () => {
    log.info(`Logged in as ${client.user.tag} (${client.user.id})`);

    try {
      const rest = new REST().setToken(TOKEN);
      await rest.put(Routes.applicationCommands(client.user.id), {
        body: slashCommands.map(c => c.toJSON()),
      });
      log.info('Slash commands registered: /new, /reset, /connection, /share-code, /bind-token, /bind');
    } catch (err) {
      log.error('Failed to register slash commands:', err.message);
    }
  });

  // Handle slash commands
  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const bridge = 'discord';
    const userId = interaction.user.id;
    const commandName = interaction.commandName;

    // Build args for command handler
    const args = [];
    if (commandName === 'connection') {
      args.push(interaction.options.getString('code'));
    } else if (commandName === 'bind') {
      args.push(interaction.options.getString('token'));
    }

    const wsPath = wm.resolveWorkspace(bridge, userId);
    const sessions = wsPath ? getSessionStore(wsPath) : null;

    const key = interaction.channel?.isDMBased()
      ? `dm:${userId}`
      : interaction.channel?.isThread()
        ? `thread:${interaction.channelId}`
        : `channel:${interaction.channelId}:${userId}`;

    const result = handleCommand(bridge, userId, { command: commandName, args }, {
      sessions,
      resetSessionKey: () => sessions && sessions.reset(key),
    });

    if (result) {
      await interaction.reply({ content: result.reply, ephemeral: !!result.ephemeral });
      log.info(`/${commandName} from ${interaction.user.tag}: ${result.reply.slice(0, 100)}`);
    } else {
      await interaction.reply({ content: 'Unknown command.', ephemeral: true });
    }
  });

  client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    if (processedMessages.has(message.id)) return;
    processedMessages.add(message.id);
    setTimeout(() => processedMessages.delete(message.id), DEDUP_TTL);

    const bridge = 'discord';
    const userId = message.author.id;

    const isDM = message.channel.isDMBased();
    const isMentioned = message.mentions.has(client.user);

    // Only respond to @mentions or DMs
    if (!isDM && !isMentioned) return;

    const content = message.content.trim();

    // Check for text-based commands (for bridges without slash command support)
    const parsed = parseCommand(content.replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '').trim());
    if (parsed) {
      const wsPath = wm.resolveWorkspace(bridge, userId);
      const sessions = wsPath ? getSessionStore(wsPath) : null;
      const key = SessionStore.keyFor(message);

      const result = handleCommand(bridge, userId, parsed, {
        sessions,
        resetSessionKey: () => sessions && sessions.reset(key),
      });

      if (result) {
        const sanitized = sanitizeOutput(result.reply, wsPath);
        if (!sanitized.safe) {
          log.warn(`[SECURITY] Blocked command reply — infrastructure leak detected`);
          await message.channel.send('Response blocked: contained restricted information.');
          return;
        }
        await message.channel.send(sanitized.text);
        return;
      }
      // If command not recognized, fall through to normal message handling
    }

    // Handle !reset for backward compat
    if (content === '!reset' || content === `<@${client.user.id}> !reset`) {
      const wsPath = wm.resolveWorkspace(bridge, userId);
      if (wsPath) {
        const sessions = getSessionStore(wsPath);
        const key = SessionStore.keyFor(message);
        sessions.reset(key);
        await message.channel.send('Session cleared. Next message starts a new conversation.');
      }
      return;
    }

    // Resolve workspace — unregistered users are silently ignored
    const wsPath = wm.resolveWorkspace(bridge, userId);
    if (!wsPath) return;

    const sessions = getSessionStore(wsPath);
    const key = SessionStore.keyFor(message);
    const uploadsDir = join(wsPath, 'uploads');

    // Strip the mention from the prompt
    let prompt = content.replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '').trim();
    if (!prompt) {
      await message.channel.send('Say something after the mention.');
      return;
    }

    // Prepend referenced message content if this is a reply
    const refContext = await fetchReferencedContent(message);
    if (refContext) prompt = refContext + prompt;

    // Append text attachment contents
    const attachmentText = await fetchTextAttachments(message, uploadsDir);
    if (attachmentText) prompt += attachmentText;

    // Truncate overly long input
    if (prompt.length > MAX_INPUT) {
      prompt = prompt.slice(0, MAX_INPUT) + '\n\n[...truncated]';
      log.warn(`Input truncated for ${message.author.tag}: ${content.length} -> ${MAX_INPUT}`);
    }

    // Add context: who is asking, which channel
    const context = isDM
      ? `[DM from ${message.author.username}]`
      : `[#${message.channel.name} -- ${message.author.username}]`;
    let fullPrompt = `${context}\n${prompt}`;

    // Start typing indicator
    let typingTimer;
    const startTyping = () => {
      message.channel.sendTyping().catch(() => {});
      typingTimer = setInterval(() => {
        message.channel.sendTyping().catch(() => {});
      }, TYPING_INTERVAL);
    };
    const stopTyping = () => clearInterval(typingTimer);

    startTyping();

    // --- Progress message state ---
    const PROGRESS_DELAY = 10000;
    let progressMsg = null;
    const progressSteps = [];
    let lastEditTime = 0;
    const EDIT_THROTTLE = 3000;
    let pendingEdit = null;
    let progressDelayTimer = null;
    let progressQueued = false;
    const requestStart = Date.now();

    const TOOL_CATEGORIES = {
      Read: { emoji: '📖', cat: 'read' },
      Glob: { emoji: '📖', cat: 'read' },
      Grep: { emoji: '🔍', cat: 'search' },
      WebSearch: { emoji: '🔍', cat: 'search' },
      WebFetch: { emoji: '🔍', cat: 'search' },
      Edit: { emoji: '✏️', cat: 'write' },
      Write: { emoji: '✏️', cat: 'write' },
      Bash: { emoji: '⚡', cat: 'exec' },
      Agent: { emoji: '🤖', cat: 'agent' },
    };
    const DEFAULT_TOOL = { emoji: '🔧', cat: 'other' };

    function categorize(name) {
      return TOOL_CATEGORIES[name] || DEFAULT_TOOL;
    }

    function categoryStats() {
      const counts = {};
      for (const step of progressSteps) {
        const { emoji, category } = step;
        if (!counts[category]) counts[category] = { emoji, count: 0 };
        counts[category].count++;
      }
      return Object.values(counts).map(c => `${c.emoji} ${c.count}`).join(' ');
    }

    function progressText() {
      if (!progressSteps.length) return '';
      const latest = progressSteps[progressSteps.length - 1];
      const line = `${latest.emoji} ${latest.description}`;
      if (progressSteps.length <= 1) return line;
      return `${line}\n-# ⚙ ${progressSteps.length} · ${categoryStats()}`;
    }

    function sendOrEditProgress() {
      const text = progressText();
      if (!progressMsg) {
        message.channel.send(text).then(msg => {
          progressMsg = msg;
          lastEditTime = Date.now();
        }).catch(err => log.debug(`Progress send failed: ${err.message}`));
      } else if (Date.now() - lastEditTime > EDIT_THROTTLE) {
        progressMsg.edit(text).catch(err => log.debug(`Progress edit failed: ${err.message}`));
        lastEditTime = Date.now();
      } else {
        if (pendingEdit) clearTimeout(pendingEdit);
        pendingEdit = setTimeout(() => {
          if (progressMsg) {
            progressMsg.edit(progressText()).catch(() => {});
            lastEditTime = Date.now();
          }
          pendingEdit = null;
        }, EDIT_THROTTLE - (Date.now() - lastEditTime));
      }
      progressQueued = false;
    }

    const TIMEOUT_CONFIRM_WAIT = 60000;

    const onProgress = async (event) => {
      if (event.type === 'timeout_confirm') {
        const remaining = event.maxExtensions - event.extensionCount;
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('timeout_continue')
            .setLabel(`繼續等 (剩 ${remaining} 次)`)
            .setStyle(ButtonStyle.Primary),
          new ButtonBuilder()
            .setCustomId('timeout_kill')
            .setLabel('不等了')
            .setStyle(ButtonStyle.Danger),
        );
        const confirmMsg = await message.channel.send({
          content: `⏱ 已執行 ${event.elapsed} 分鐘（${event.eventCount} events），要繼續等嗎？（60 秒內未回應將自動停止）`,
          components: [row],
        });
        try {
          const interaction = await confirmMsg.awaitMessageComponent({
            filter: (i) => i.user.id === message.author.id,
            time: TIMEOUT_CONFIRM_WAIT,
          });
          const cont = interaction.customId === 'timeout_continue';
          await interaction.update({
            content: cont ? `⏱ 繼續執行中...（已延長 ${event.extensionCount + 1} 次）` : '⏱ 正在停止...',
            components: [],
          });
          return cont;
        } catch {
          await confirmMsg.edit({ content: '⏱ 未回應，已自動停止。', components: [] }).catch(() => {});
          return false;
        }
      }

      if (event.type === 'tool_start') {
        const { emoji, cat } = categorize(event.name);
        progressSteps.push({ name: event.name, description: event.description, category: cat, emoji });

        const elapsed = Date.now() - requestStart;
        if (elapsed >= PROGRESS_DELAY) {
          sendOrEditProgress();
        } else if (!progressDelayTimer) {
          progressQueued = true;
          progressDelayTimer = setTimeout(() => {
            progressDelayTimer = null;
            if (progressQueued) sendOrEditProgress();
          }, PROGRESS_DELAY - elapsed);
        } else {
          progressQueued = true;
        }
      } else if (event.type === 'done') {
        if (progressDelayTimer) {
          clearTimeout(progressDelayTimer);
          progressDelayTimer = null;
        }
        if (pendingEdit) clearTimeout(pendingEdit);
        if (progressMsg) {
          let completed = `✅ Done · ${progressSteps.length} steps`;
          completed += `\n-# ${categoryStats()}`;
          if (event.agentInputTokens || event.agentOutputTokens) {
            const fmt = (n) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
            const agentTotal = event.agentInputTokens + event.agentOutputTokens;
            completed += ` · ⚡ ${fmt(agentTotal)} (${fmt(event.agentInputTokens)}in/${fmt(event.agentOutputTokens)}out)`;
          }
          progressMsg.edit(completed).catch(() => {});
        }
      }
    };

    try {
      const compactStatus = sessions.getCompactStatus(key);
      let isResume;
      let sessionId;

      if (compactStatus.needsCompact && compactStatus.sessionId) {
        log.info(`Compact triggered for ${key}, generating summary...`);

        let summary = '';
        try {
          const summaryResult = await enqueue(
            'Please summarize our conversation so far in 2-3 concise sentences. Focus on key topics discussed and any ongoing tasks.',
            compactStatus.sessionId,
            true,
            null,
            wsPath,
          );
          summary = summaryResult.text || '';
          log.info(`Compact summary: ${summary.slice(0, 200)}`);
        } catch (err) {
          log.warn(`Compact summary failed: ${err.message}, rotating anyway`);
        }

        sessionId = sessions.rotateSession(key);
        isResume = false;

        if (summary) {
          fullPrompt = `[Context from previous conversation: ${summary}]\n\n${fullPrompt}`;
        }
      } else {
        const existingSession = sessions.get(key);
        isResume = !!existingSession;
        sessionId = sessions.getOrCreate(key);
      }

      log.info(`Request from ${message.author.tag} [${key}] resume=${isResume} ws=${wsPath}`);
      let result;
      try {
        result = await enqueue(fullPrompt, sessionId, isResume, onProgress, wsPath);
      } catch (err) {
        if (isResume && !err.timedOut) {
          log.warn(`Resume failed for ${key} (${err.message}), retrying with new session`);
          sessions.reset(key);
          const newSessionId = sessions.getOrCreate(key);
          result = await enqueue(fullPrompt, newSessionId, false, onProgress, wsPath);
        } else {
          throw err;
        }
      }

      stopTyping();

      if (result.inputTokens) {
        sessions.updateTokens(key, result.inputTokens);
      }

      const responseText = result.text || '';

      // Append to talk-history for seed-watering trigger
      appendTalkHistory(wsPath, prompt, responseText);

      if (!responseText.trim()) {
        await message.channel.send('(no response from Claude)');
        return;
      }

      // Collect outbox files before sending
      const outboxFiles = collectOutbox(wsPath);
      if (outboxFiles.length) {
        log.info(`Outbox: ${outboxFiles.length} file(s) to attach (${outboxFiles.map(f => f.name).join(', ')})`);
      }

      const shortId = sessionId.slice(0, 8);
      const fmtTokens = (n) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
      const limit = parseInt(process.env.COMPACT_THRESHOLD || '80000', 10);
      const pct = ((result.inputTokens / limit) * 100).toFixed(1);
      const tokenInfo = `⛁ ${fmtTokens(result.inputTokens)} (${pct}%)`;
      const withFooter = responseText + `\n\n-# ⎔ ${shortId} · ${tokenInfo}`;
      const chunks = splitMessage(withFooter);
      for (let i = 0; i < chunks.length; i++) {
        const sanitized = sanitizeOutput(chunks[i], wsPath);
        if (!sanitized.safe) {
          log.warn(`[SECURITY] Blocked response chunk ${i} — infrastructure leak detected`);
          await message.channel.send('Response blocked: contained restricted information.');
          break;
        }
        // Attach outbox files to the last chunk
        const isLast = i === chunks.length - 1;
        if (isLast && outboxFiles.length) {
          await message.channel.send({ content: sanitized.text, files: outboxFiles });
        } else {
          await message.channel.send(sanitized.text);
        }
      }
    } catch (err) {
      stopTyping();
      if (pendingEdit) clearTimeout(pendingEdit);
      if (progressMsg) {
        const failed = `❌ Failed · ${progressSteps.length} steps\n-# ${categoryStats()}`;
        progressMsg.edit(failed).catch(() => {});
      }
      log.error(`Error handling message from ${message.author.tag}:`, err.message);
      const errSanitized = sanitizeOutput(`Something went wrong: ${err.message.slice(0, 200)}`, wsPath);
      await message.channel.send(errSanitized.safe ? errSanitized.text : 'Something went wrong.').catch(() => {});
    }
  });
}

async function start() {
  TOKEN = process.env.DISCORD_TOKEN;
  if (!TOKEN) {
    log.error('DISCORD_TOKEN not set. Set it in .env');
    throw new Error('DISCORD_TOKEN not set');
  }

  TTL = parseInt(process.env.SESSION_TTL_MINUTES || '60', 10);

  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel],
  });

  setupEventHandlers();

  await client.login(TOKEN);
}

function cleanup() {
  log.info('Discord bridge shutting down...');
  for (const store of sessionStores.values()) {
    store.destroy();
  }
  sessionStores.clear();
  if (client) client.destroy();
  log.info('Discord bridge stopped');
}

/**
 * Send a DM to a Discord user by ID.
 * @param {string} userId
 * @param {string} text
 * @param {Array<{attachment: Buffer, name: string}>} [files]
 */
async function sendDM(userId, text, files) {
  if (!client) return;
  try {
    const user = await client.users.fetch(userId);
    if (files && files.length) {
      await user.send({ content: text, files });
    } else {
      await user.send(text);
    }
    log.info(`DM sent to discord:${userId}${files ? ` (${files.length} files)` : ''}`);
  } catch (err) {
    log.warn(`Failed to send DM to discord:${userId}: ${err.message}`);
  }
}

module.exports = { name: 'discord', start, cleanup, sendDM };
