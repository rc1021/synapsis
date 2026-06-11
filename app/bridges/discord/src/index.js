const { Client, GatewayIntentBits, Partials, SlashCommandBuilder, REST, Routes, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { resolve, join, sep, basename, extname } = require('path');
const fs = require('fs');
const SessionStore = require('./session-store');
const { enqueue } = require('./claude-runner');
const { classifyTier } = require('../../shared/tier-classifier');
const { TIER_MODELS } = require('../../shared/runner');
const { splitMessage } = require('./message-splitter');
const { parseCommand, handleCommand } = require('../../shared/command-handler');
const wm = require('../../shared/workspace-manager');
const { sanitizeOutput, isTextFile, TEXT_EXTENSIONS } = require('../../shared/sanitize');
const engagement = require('../../shared/engagement');
const webBridge = require('../../web/src/index');
const { searchWorkspace } = require('../../shared/embedding-search');
const driveAuth = require('../../shared/drive-auth');
const { toSpeechText } = require('../../shared/markdown-to-speech');
const ttsRegistry = require('../../shared/tts/registry');
const { mergeBuffers, groupBySize } = require('../../shared/tts/merge');
const log = require('./logger');

const MAX_INPUT = 8000;
const OUTBOX_DIR = 'outbox';
const MAX_DISCORD_FILE_SIZE = 10 * 1024 * 1024; // 10MB per file

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
    .setDescription('Start a new conversation (clear current session)')
    .setDescriptionLocalizations({
      'zh-TW': '開始新對話（清除目前 session）',
      'zh-CN': '开始新对话（清除当前 session）',
      ja: '新しい会話を開始（現在のセッションをクリア）',
      ko: '새 대화 시작 (현재 세션 초기화)',
    }),
  new SlashCommandBuilder()
    .setName('reset')
    .setDescription('Clear current session')
    .setDescriptionLocalizations({
      'zh-TW': '清除目前 session',
      'zh-CN': '清除当前 session',
      ja: '現在のセッションをクリア',
      ko: '현재 세션 초기화',
    }),
  new SlashCommandBuilder()
    .setName('connection')
    .setDescription('Register with an invite code')
    .setDescriptionLocalizations({
      'zh-TW': '用邀請碼註冊',
      'zh-CN': '用邀请码注册',
      ja: '招待コードで登録',
      ko: '초대 코드로 등록',
    })
    .addStringOption(opt => opt
      .setName('code')
      .setDescription('Invite code')
      .setDescriptionLocalizations({
        'zh-TW': '邀請碼',
        'zh-CN': '邀请码',
        ja: '招待コード',
        ko: '초대 코드',
      })
      .setRequired(true)),
  new SlashCommandBuilder()
    .setName('share-code')
    .setDescription('Generate an invite code to share')
    .setDescriptionLocalizations({
      'zh-TW': '產生邀請碼分享給別人',
      'zh-CN': '生成邀请码分享给别人',
      ja: '共有用の招待コードを生成',
      ko: '공유할 초대 코드 생성',
    }),
  new SlashCommandBuilder()
    .setName('bind-token')
    .setDescription('Generate a token to bind another bridge account')
    .setDescriptionLocalizations({
      'zh-TW': '產生跨平台帳號綁定 token',
      'zh-CN': '生成跨平台账号绑定 token',
      ja: '別プラットフォームのアカウント連携トークンを生成',
      ko: '다른 플랫폼 계정 연결 토큰 생성',
    }),
  new SlashCommandBuilder()
    .setName('bind')
    .setDescription('Bind this account to an existing workspace')
    .setDescriptionLocalizations({
      'zh-TW': '將此帳號綁定到已有的工作空間',
      'zh-CN': '将此账号绑定到已有的工作空间',
      ja: 'このアカウントを既存のワークスペースに連携',
      ko: '이 계정을 기존 워크스페이스에 연결',
    })
    .addStringOption(opt => opt
      .setName('token')
      .setDescription('Bind token')
      .setDescriptionLocalizations({
        'zh-TW': '綁定 token',
        'zh-CN': '绑定 token',
        ja: '連携トークン',
        ko: '바인딩 토큰',
      })
      .setRequired(true)),
  new SlashCommandBuilder()
    .setName('commons')
    .setDescription('Soul Commons — read what the souls are thinking (public)')
    .setDescriptionLocalizations({
      'zh-TW': '靈魂廣場 — 閱讀靈魂的思考（公開）',
      'zh-CN': '灵魂广场 — 阅读灵魂的思考（公开）',
      ja: 'ソウルコモンズ — ソウルの思考を読む（公開）',
      ko: '소울 커먼즈 — 소울의 생각 읽기 (공개)',
    }),
  new SlashCommandBuilder()
    .setName('dashboard')
    .setDescription('Open file manager')
    .setDescriptionLocalizations({
      'zh-TW': '開啟檔案管理',
      'zh-CN': '打开文件管理',
      ja: 'ファイルマネージャーを開く',
      ko: '파일 관리자 열기',
    }),
  new SlashCommandBuilder()
    .setName('todo')
    .setDescription('List or add todos')
    .setDescriptionLocalizations({
      'zh-TW': '列出或新增待辦事項',
      'zh-CN': '列出或新增待办事项',
      ja: 'TODOの一覧・追加',
      ko: '할 일 목록/추가',
    })
    .addStringOption(opt => opt
      .setName('item')
      .setDescription('Todo item to add (leave empty to list)')
      .setDescriptionLocalizations({
        'zh-TW': '要新增的待辦（留空列出）',
        'zh-CN': '要新增的待办（留空列出）',
        ja: '追加するTODO（空で一覧）',
        ko: '추가할 할 일 (비워두면 목록)',
      })
      .setRequired(false)),
  new SlashCommandBuilder()
    .setName('help')
    .setDescription('Show available commands')
    .setDescriptionLocalizations({
      'zh-TW': '顯示可用指令',
      'zh-CN': '显示可用命令',
      ja: '利用可能なコマンドを表示',
      ko: '사용 가능한 명령어 표시',
    }),
  new SlashCommandBuilder()
    .setName('yt')
    .setDescription('Fetch YouTube transcript and analyze')
    .setDescriptionLocalizations({
      'zh-TW': '取得 YouTube 逐字稿並分析',
      'zh-CN': '获取 YouTube 逐字稿并分析',
      ja: 'YouTube の文字起こしを取得して分析',
      ko: 'YouTube 자막을 가져와 분석',
    })
    .addStringOption(opt => opt
      .setName('video')
      .setDescription('YouTube URL or Video ID')
      .setDescriptionLocalizations({
        'zh-TW': 'YouTube 網址或影片 ID',
        'zh-CN': 'YouTube 网址或视频 ID',
        ja: 'YouTube URL または動画 ID',
        ko: 'YouTube URL 또는 동영상 ID',
      })
      .setRequired(false))
    .addBooleanOption(opt => opt
      .setName('verify')
      .setDescription('Verify & explore content (fact-check + notes)')
      .setDescriptionLocalizations({
        'zh-TW': '驗證且探索內容（事實查核 + 筆記）',
        'zh-CN': '验证并探索内容（事实核查 + 笔记）',
        ja: 'コンテンツを検証・探索（ファクトチェック + ノート）',
        ko: '콘텐츠 검증 및 탐색 (팩트체크 + 노트)',
      })
      .setRequired(false)),
  new SlashCommandBuilder()
    .setName('pod')
    .setDescription('Fetch podcast transcript and analyze')
    .setDescriptionLocalizations({
      'zh-TW': '取得 Podcast 逐字稿並分析',
      'zh-CN': '获取 Podcast 逐字稿并分析',
    })
    .addStringOption(opt => opt
      .setName('url')
      .setDescription('Podcast episode URL (Castbox, SoundOn, Apple Podcasts, etc.)')
      .setDescriptionLocalizations({
        'zh-TW': 'Podcast 集數網址（Castbox、SoundOn、Apple Podcasts 等）',
        'zh-CN': 'Podcast 单集网址',
      })
      .setRequired(false))
    .addBooleanOption(opt => opt
      .setName('verify')
      .setDescription('Verify & explore content (fact-check + notes)')
      .setDescriptionLocalizations({
        'zh-TW': '驗證且探索內容（事實查核 + 筆記）',
        'zh-CN': '验证并探索内容（事实核查 + 笔记）',
      })
      .setRequired(false)),
  new SlashCommandBuilder()
    .setName('drive-connect')
    .setDescription('Connect Google Drive to your workspace')
    .setDescriptionLocalizations({
      'zh-TW': '連接 Google Drive 到你的 workspace',
      'zh-CN': '连接 Google Drive 到你的 workspace',
    }),
  new SlashCommandBuilder()
    .setName('drive-sync')
    .setDescription('Sync workspace files to Google Drive')
    .setDescriptionLocalizations({
      'zh-TW': '同步 workspace 到 Google Drive',
      'zh-CN': '同步 workspace 到 Google Drive',
    }),
  new SlashCommandBuilder()
    .setName('search')
    .setDescription('Semantically search your workspace notes')
    .setDescriptionLocalizations({
      'zh-TW': '語意搜尋 workspace 筆記',
      'zh-CN': '语义搜索 workspace 笔记',
      ja: 'ワークスペースのノートをセマンティック検索',
      ko: '워크스페이스 노트 시맨틱 검색',
    })
    .addStringOption(opt => opt
      .setName('query')
      .setDescription('Search query')
      .setDescriptionLocalizations({
        'zh-TW': '搜尋關鍵字或描述',
        'zh-CN': '搜索关键词或描述',
        ja: '検索キーワードや説明',
        ko: '검색 키워드 또는 설명',
      })
      .setRequired(true)),
  new SlashCommandBuilder()
    .setName('list')
    .setDescription('List files and folders in your workspace')
    .setDescriptionLocalizations({
      'zh-TW': '列出 workspace 資料夾內容',
      'zh-CN': '列出 workspace 文件夹内容',
      ja: 'ワークスペースのフォルダ内容を表示',
      ko: '워크스페이스 폴더 내용 표시',
    })
    .addStringOption(opt => opt
      .setName('path')
      .setDescription('Relative path to a folder (default: workspace root)')
      .setDescriptionLocalizations({
        'zh-TW': '資料夾的相對路徑（預設為根目錄）',
        'zh-CN': '文件夹的相对路径（默认为根目录）',
        ja: 'フォルダの相対パス（デフォルト: ルート）',
        ko: '폴더의 상대 경로 (기본값: 루트)',
      })
      .setRequired(false)),
  new SlashCommandBuilder()
    .setName('speak')
    .setDescription('Convert a workspace note to speech audio')
    .setDescriptionLocalizations({
      'zh-TW': '將筆記轉換為語音',
      'zh-CN': '将笔记转换为语音',
      ja: 'ノートを音声に変換',
      ko: '노트를 음성으로 변환',
    })
    .addStringOption(opt => opt
      .setName('note')
      .setDescription('Relative path to the note (e.g. memory/2026-06-10.md)')
      .setDescriptionLocalizations({
        'zh-TW': '筆記的相對路徑（例如 memory/2026-06-10.md）',
        'zh-CN': '笔记的相对路径（例如 memory/2026-06-10.md）',
        ja: 'ノートの相対パス（例: memory/2026-06-10.md）',
        ko: '노트의 상대 경로 (예: memory/2026-06-10.md)',
      })
      .setRequired(true)),
];

// Send chunked interaction reply with DM fallback when token expires (>15 min)
async function sendChunkedReply(interaction, chunks, outboxFiles) {
  let useDM = false;
  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    const payload = isLast && outboxFiles.length
      ? { content: chunks[i], files: outboxFiles }
      : chunks[i];

    if (useDM) {
      await interaction.user.send(payload);
      continue;
    }

    try {
      if (i === 0) {
        await interaction.editReply(payload);
      } else {
        await interaction.followUp(payload);
      }
    } catch (err) {
      // Interaction token expired — fall back to DM
      if (err.code === 10015 || /invalid webhook token|unknown webhook/i.test(err.message)) {
        useDM = true;
        const dmPayload = typeof payload === 'string'
          ? `*(處理時間較長，改用私訊回覆)*\n\n${payload}`
          : { ...payload, content: `*(處理時間較長，改用私訊回覆)*\n\n${payload.content}` };
        await interaction.user.send(dmPayload);
      } else {
        throw err;
      }
    }
  }
}

const MESSAGE_SPLITTER_DIR = '.messageSplitter';

async function saveMessageGroup(wsPath, messageIds) {
  if (messageIds.length < 2) return;
  const dir = join(wsPath, MESSAGE_SPLITTER_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const filename = messageIds.join('|');
  fs.writeFileSync(join(dir, filename), '');
}

async function findMessageGroup(wsPath, messageId) {
  const dir = join(wsPath, MESSAGE_SPLITTER_DIR);
  if (!fs.existsSync(dir)) return null;
  const matches = await fs.promises.glob(`*${messageId}*`, { cwd: dir });
  if (!matches.length) return null;
  return matches[0].split('|');
}

async function fetchReferencedContent(message, wsPath) {
  if (!message.reference?.messageId) return '';
  try {
    const refId = message.reference.messageId;
    const groupIds = wsPath ? await findMessageGroup(wsPath, refId) : null;

    if (groupIds && groupIds.length > 1) {
      const refs = await Promise.all(groupIds.map(id => message.channel.messages.fetch(id).catch(() => null)));
      const validRefs = refs.filter(Boolean);
      const authorLabel = validRefs[0].author.id === message.client.user.id ? 'Claude (you)' : validRefs[0].author.username;
      const fullText = validRefs.map(r => r.content || '').join('');
      if (!fullText) return '';
      return `[Replying to ${authorLabel}: "${fullText}"]\n`;
    }

    const ref = await message.channel.messages.fetch(refId);
    if (!ref) return '';

    let text = ref.content || '';
    const authorLabel = ref.author.id === message.client.user.id
      ? 'Claude (you)'
      : ref.author.username;

    const attachments = ref.attachments.size > 0
      ? `\n[Attachments: ${ref.attachments.map(a => a.name).join(', ')}]`
      : '';

    if (!text && !attachments) return '';

    return `[Replying to ${authorLabel}: "${text}${attachments}"]\n`;
  } catch (err) {
    log.warn(`Failed to fetch referenced message: ${err.message}`);
    return '';
  }
}

/**
 * Fetch all attachments from a Discord message and save them to disk.
 * All file types (text, images, PDFs, Excel, etc.) are saved to uploads/.
 * Returns a text annotation telling the AI where each file is and how to read it.
 */
async function fetchAttachments(message, uploadsDir) {
  if (!message.attachments.size) return '';

  fs.mkdirSync(uploadsDir, { recursive: true });

  const parts = [];
  const savedFiles = [];

  for (const [, att] of message.attachments) {
    const ext = (att.name || '').match(/\.[^.]+$/)?.[0]?.toLowerCase() || '';
    const isText = TEXT_EXTENSIONS.has(ext) || (att.contentType && att.contentType.startsWith('text/'));
    const isImage = ['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext);
    const isPdf = ext === '.pdf';

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
      if (isText) {
        parts.push(`[User uploaded file "${att.name}" (${sizeKB}KB) -> saved to uploads/${fileName} -- use the Read tool to read it]`);
      } else if (isImage) {
        parts.push(`[User uploaded image "${att.name}" (${sizeKB}KB) -> saved to uploads/${fileName} -- use the Read tool to view it]`);
      } else if (isPdf) {
        parts.push(`[User uploaded PDF "${att.name}" (${sizeKB}KB) -> saved to uploads/${fileName} -- use the Read tool to read it]`);
      } else {
        parts.push(`[User uploaded file "${att.name}" (${sizeKB}KB) -> saved to uploads/${fileName} -- use appropriate tools to read it]`);
      }
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
      log.info('Slash commands registered: /new, /reset, /search, /commons, /dashboard, /list, /todo, /yt, /pod, /speak, /drive-connect, /drive-sync, /connection, /share-code, /bind-token, /bind');
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

    // --- /yt: async handler (deferReply → transcript → AI) ---
    if (commandName === 'yt') {
      const video = interaction.options.getString('video');
      const verify = interaction.options.getBoolean('verify') || false;

      // Help: no video arg
      if (!video) {
        const helpLines = [
          '**`/yt` — YouTube 逐字稿分析**',
          '',
          '用法:',
          '`/yt video:<YouTube URL 或 Video ID>` — 下載逐字稿 + AI 摘要',
          '`/yt video:<URL> verify:true` — 下載逐字稿 + 驗證探索 + 筆記',
          '',
          '流程:',
          '1. 嘗試下載 YouTube 字幕',
          '2. 無字幕時自動改用 Whisper 語音轉文字',
          '3. AI 分析逐字稿並回覆摘要',
          '4. （verify 模式）事實查核 + 領域探索 + 整理筆記',
        ];
        await interaction.reply({ content: helpLines.join('\n'), ephemeral: true });
        return;
      }

      // Must be registered
      const wsPath = wm.resolveWorkspace(bridge, userId);
      if (!wsPath) {
        await interaction.reply({ content: '你尚未註冊，請先使用 `/connection <邀請碼>` 註冊。', ephemeral: true });
        return;
      }

      await interaction.deferReply();

      try {
        // Step 1: Run yt-transcript.py
        const transcriptsDir = join(wsPath, 'transcripts');
        fs.mkdirSync(transcriptsDir, { recursive: true });

        const toolsDir = resolve(__dirname, '..', '..', '..', 'tools');
        const scriptPath = join(toolsDir, 'yt-transcript.py');
        const langArg = process.env.YT_DEFAULT_LANG || 'zh';

        log.info(`/yt from ${interaction.user.tag}: video=${video} verify=${verify}`);

        const proc = await new Promise((resolveProc, rejectProc) => {
          const child = require('child_process').spawn(
            'python3', [scriptPath, video, '--lang', langArg, '--output', transcriptsDir],
            { timeout: 1200000 }, // 20 min max (Whisper can be slow)
          );
          let stdout = '';
          let stderr = '';
          child.stdout.on('data', (d) => { stdout += d; });
          child.stderr.on('data', (d) => { stderr += d; });
          child.on('close', (code) => {
            if (code === 0) resolveProc({ stdout: stdout.trim(), stderr: stderr.trim() });
            else rejectProc(new Error(stderr.trim() || `yt-transcript.py exited with code ${code}`));
          });
          child.on('error', rejectProc);
        });

        const savedFilePath = proc.stdout; // yt-transcript.py prints the file path when --output is used
        if (!savedFilePath || !fs.existsSync(savedFilePath)) {
          await interaction.editReply('逐字稿下載失敗：找不到輸出檔案。');
          return;
        }

        const fileName = require('path').basename(savedFilePath);
        log.info(`/yt transcript saved: ${savedFilePath}`);
        if (proc.stderr) log.debug(`/yt stderr: ${proc.stderr}`);

        // Step 2: Build prompt for AI
        const fileAnnotation = `[User requested YouTube transcript via /yt — file "${fileName}" saved to transcripts/${fileName} -- use the Read tool to read it]`;

        let aiPrompt;
        if (verify) {
          // Read the spec for verify-explore
          const specPath = resolve(__dirname, '..', '..', '..', 'scheduler', 'specs', 'verify-explore-spec.md');
          let specContent = '';
          try {
            specContent = fs.readFileSync(specPath, 'utf-8');
          } catch {
            log.warn('/yt verify: could not read verify-explore-spec.md');
          }

          aiPrompt = `[DM from ${interaction.user.username}]\n` +
            `${fileAnnotation}\n\n` +
            `用戶透過 /yt 指令請求「驗證且探索」這份 YouTube 逐字稿。\n\n` +
            `請依照以下 spec 執行完整流程（內容分析 → 事實查核 → 領域邊界探索 → 整理筆記到 memory/learning/notes/conversations/），` +
            `完成後回覆用戶整理摘要。使用 sub-agent (Agent tool) 執行。\n\n` +
            `--- SPEC ---\n${specContent}`;
        } else {
          aiPrompt = `[DM from ${interaction.user.username}]\n` +
            `${fileAnnotation}\n\n` +
            `用戶透過 /yt 指令上傳了 YouTube 逐字稿，請閱讀並提供重點摘要。`;
        }

        // Step 3: Enqueue AI
        const sessions = getSessionStore(wsPath);
        const key = interaction.channel?.isDMBased()
          ? `dm:${userId}`
          : interaction.channel?.isThread()
            ? `thread:${interaction.channelId}`
            : `channel:${interaction.channelId}:${userId}`;

        const existingSession = sessions.get(key);
        const isResume = !!existingSession;
        const sessionId = sessions.getOrCreate(key);

        const result = await enqueue(aiPrompt, sessionId, isResume, null, wsPath);

        if (result.inputTokens) {
          sessions.updateTokens(key, result.inputTokens);
        }

        // Step 4: Reply with split messages
        let responseText = result.text || '(no response)';

        // Replace web access markers
        const wsRel = wm.readIndex(bridge, userId);
        if (wsRel) {
          responseText = responseText.replace(/\[REQUEST_WEB_ACCESS\]/g, webBridge.generateAccessUrl(wsRel));
          responseText = responseText.replace(/\[REQUEST_WEB_FILE:([^\]]+)\]/g, (_, filePath) => {
            return webBridge.generateAccessUrl(wsRel, filePath.trim());
          });
        }

        wm.appendTalkHistory(wsPath, `/yt ${video}${verify ? ' verify:true' : ''}`, responseText);

        const outboxFiles = collectOutbox(wsPath);

        const shortId = sessionId.slice(0, 8);
        const fmtTokens = (n) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
        const limit = parseInt(process.env.COMPACT_THRESHOLD || '180000', 10);
        const pct = ((result.inputTokens / limit) * 100).toFixed(1);
        const tokenInfo = `⛁ ${fmtTokens(result.inputTokens)} (${pct}%)`;
        const withFooter = responseText + `\n\n-# ⎔ ${shortId} · ${tokenInfo}`;
        const chunks = splitMessage(withFooter);

        // First chunk goes as editReply (the deferred reply), rest as follow-ups
        const sanitizedChunks = [];
        let ytSecurityBlocked = false;
        for (let i = 0; i < chunks.length; i++) {
          const sanitized = sanitizeOutput(chunks[i], wsPath);
          if (!sanitized.safe) {
            log.warn(`[SECURITY] /yt blocked response chunk ${i} — pattern: ${sanitized.blockedBy} — matched: "${sanitized.matchedText}"`);
            if (i === 0) await interaction.editReply('Response blocked: contained restricted information.');
            ytSecurityBlocked = true;
            break;
          }
          sanitizedChunks.push(sanitized.text);
        }
        if (!ytSecurityBlocked) {
          await sendChunkedReply(interaction, sanitizedChunks, outboxFiles);
        }

        log.info(`/yt complete for ${interaction.user.tag}: ${chunks.length} chunks`);
      } catch (err) {
        log.error(`/yt error for ${interaction.user.tag}: ${err.message}`);
        const errMsg = `處理失敗: ${err.message.slice(0, 200)}`;
        try {
          await interaction.editReply(errMsg);
        } catch {
          await interaction.user.send(errMsg).catch(() => {});
        }
      }
      return;
    }

    // --- /pod: async handler (deferReply → podcast transcript via Whisper → AI) ---
    if (commandName === 'pod') {
      const podUrl = interaction.options.getString('url');
      const podVerify = interaction.options.getBoolean('verify') || false;

      // Help: no url arg
      if (!podUrl) {
        const helpLines = [
          '**`/pod` — Podcast 逐字稿分析**',
          '',
          '用法:',
          '`/pod url:<Podcast 集數網址>` — 下載逐字稿 + AI 摘要 + 自動存筆記',
          '`/pod url:<URL> verify:true` — 同上 + WebSearch 事實查核',
          '',
          '支援平台: Castbox、SoundOn、Apple Podcasts 及所有 yt-dlp 支援的 Podcast 平台',
          '',
          '流程:',
          '1. yt-dlp 下載音訊',
          '2. Whisper 語音轉文字（逐字稿永久保留在 transcripts/）',
          '3. AI 摘要 + 結構化筆記存到 notes/',
        ];
        await interaction.reply({ content: helpLines.join('\n'), ephemeral: true });
        return;
      }

      // Must be registered
      const wsPathPod = wm.resolveWorkspace(bridge, userId);
      if (!wsPathPod) {
        await interaction.reply({ content: '你尚未註冊，請先使用 `/connection <邀請碼>` 註冊。', ephemeral: true });
        return;
      }

      await interaction.deferReply();

      try {
        const transcriptsDir = join(wsPathPod, 'transcripts');
        fs.mkdirSync(transcriptsDir, { recursive: true });

        const toolsDir = resolve(__dirname, '..', '..', '..', 'tools');
        const scriptPath = join(toolsDir, 'pod-transcript.py');
        const langArg = process.env.POD_DEFAULT_LANG || 'zh';

        log.info(`/pod from ${interaction.user.tag}: url=${podUrl} verify=${podVerify}`);

        const proc = await new Promise((resolveProc, rejectProc) => {
          const child = require('child_process').spawn(
            'python3', [scriptPath, podUrl, '--lang', langArg, '--output', transcriptsDir],
            { timeout: 1800000 }, // 30 min max (podcast episodes can be long)
          );
          let stdout = '';
          let stderr = '';
          child.stdout.on('data', (d) => { stdout += d; });
          child.stderr.on('data', (d) => { stderr += d; });
          child.on('close', (code) => {
            if (code === 0) resolveProc({ stdout: stdout.trim(), stderr: stderr.trim() });
            else rejectProc(new Error(stderr.trim() || `pod-transcript.py exited with code ${code}`));
          });
          child.on('error', rejectProc);
        });

        const savedFilePath = proc.stdout;
        if (!savedFilePath || !fs.existsSync(savedFilePath)) {
          await interaction.editReply('逐字稿下載失敗：找不到輸出檔案。');
          return;
        }

        const fileName = require('path').basename(savedFilePath);
        log.info(`/pod transcript saved: ${savedFilePath}`);
        if (proc.stderr) log.debug(`/pod stderr: ${proc.stderr}`);

        const fileAnnotation = `[User requested Podcast transcript via /pod — file "${fileName}" saved to transcripts/${fileName} -- use the Read tool to read it]`;

        let aiPrompt;
        if (podVerify) {
          const specPath = resolve(__dirname, '..', '..', '..', 'scheduler', 'specs', 'verify-explore-spec.md');
          let specContent = '';
          try {
            specContent = fs.readFileSync(specPath, 'utf-8');
          } catch {
            log.warn('/pod verify: could not read verify-explore-spec.md');
          }
          aiPrompt = `[DM from ${interaction.user.username}]\n` +
            `${fileAnnotation}\n\n` +
            `用戶透過 /pod 指令請求「驗證且探索」這份 Podcast 逐字稿。\n\n` +
            `請依照以下 spec 執行完整流程（內容分析 → 事實查核 → 領域邊界探索 → 整理筆記到 notes/），` +
            `完成後回覆用戶整理摘要。使用 sub-agent (Agent tool) 執行。\n\n` +
            `--- SPEC ---\n${specContent}`;
        } else {
          aiPrompt = `[DM from ${interaction.user.username}]\n` +
            `${fileAnnotation}\n\n` +
            `用戶透過 /pod 指令上傳了 Podcast 逐字稿，請：\n` +
            `1. 閱讀逐字稿，回覆重點摘要（核心觀點、精彩段落、金句）\n` +
            `2. 將結構化筆記（主題、重點、可行動事項）存到 notes/ 目錄下適當位置\n` +
            `3. 如果逐字稿中有值得深挖的主題或概念（不超過 3 個），在回覆末尾列出，問用戶是否加進探索清單`;
        }

        const sessionsPod = getSessionStore(wsPathPod);
        const keyPod = interaction.channel?.isDMBased()
          ? `dm:${userId}`
          : interaction.channel?.isThread()
            ? `thread:${interaction.channelId}`
            : `channel:${interaction.channelId}:${userId}`;

        const existingSessionPod = sessionsPod.get(keyPod);
        const isResumePod = !!existingSessionPod;
        const sessionIdPod = sessionsPod.getOrCreate(keyPod);

        const resultPod = await enqueue(aiPrompt, sessionIdPod, isResumePod, null, wsPathPod);

        if (resultPod.inputTokens) {
          sessionsPod.updateTokens(keyPod, resultPod.inputTokens);
        }

        let responseTextPod = resultPod.text || '(no response)';

        const wsRelPod = wm.readIndex(bridge, userId);
        if (wsRelPod) {
          responseTextPod = responseTextPod.replace(/\[REQUEST_WEB_ACCESS\]/g, webBridge.generateAccessUrl(wsRelPod));
          responseTextPod = responseTextPod.replace(/\[REQUEST_WEB_FILE:([^\]]+)\]/g, (_, filePath) => {
            return webBridge.generateAccessUrl(wsRelPod, filePath.trim());
          });
        }

        wm.appendTalkHistory(wsPathPod, `/pod ${podUrl}${podVerify ? ' verify:true' : ''}`, responseTextPod);

        const outboxFilesPod = collectOutbox(wsPathPod);

        const shortIdPod = sessionIdPod.slice(0, 8);
        const fmtTokensPod = (n) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
        const limitPod = parseInt(process.env.COMPACT_THRESHOLD || '180000', 10);
        const pctPod = ((resultPod.inputTokens / limitPod) * 100).toFixed(1);
        const tokenInfoPod = `⛁ ${fmtTokensPod(resultPod.inputTokens)} (${pctPod}%)`;
        const withFooterPod = responseTextPod + `\n\n-# ⎔ ${shortIdPod} · ${tokenInfoPod}`;
        const chunksPod = splitMessage(withFooterPod);

        const sanitizedChunksPod = [];
        let podSecurityBlocked = false;
        for (let i = 0; i < chunksPod.length; i++) {
          const sanitized = sanitizeOutput(chunksPod[i], wsPathPod);
          if (!sanitized.safe) {
            log.warn(`[SECURITY] /pod blocked response chunk ${i} — pattern: ${sanitized.blockedBy} — matched: "${sanitized.matchedText}"`);
            if (i === 0) await interaction.editReply('Response blocked: contained restricted information.');
            podSecurityBlocked = true;
            break;
          }
          sanitizedChunksPod.push(sanitized.text);
        }
        if (!podSecurityBlocked) {
          await sendChunkedReply(interaction, sanitizedChunksPod, outboxFilesPod);
        }

        log.info(`/pod complete for ${interaction.user.tag}: ${chunksPod.length} chunks`);
      } catch (err) {
        log.error(`/pod error for ${interaction.user.tag}: ${err.message}`);
        const errMsg = `處理失敗: ${err.message.slice(0, 200)}`;
        try {
          await interaction.editReply(errMsg);
        } catch {
          await interaction.user.send(errMsg).catch(() => {});
        }
      }
      return;
    }

    // --- /speak: convert a workspace note to speech audio ---
    if (commandName === 'speak') {
      const note = interaction.options.getString('note');

      if (!note) {
        const helpLines = [
          '**`/speak` — 將筆記轉換為語音**',
          '',
          '用法:',
          '`/speak note:<相對路徑>` — 例如 `/speak note:memory/2026-06-10.md`',
          '',
          '支援 .md / .markdown / .txt 筆記檔案，整篇轉換並合併為單一語音檔。',
        ];
        await interaction.reply({ content: helpLines.join('\n'), ephemeral: true });
        return;
      }

      const tts = ttsRegistry.get();
      if (!tts.isConfigured()) {
        await interaction.reply({ content: `語音功能尚未設定（管理員需設定 \`${tts.configHint}\`）。`, ephemeral: true });
        return;
      }

      const wsPathSpeak = wm.resolveWorkspace(bridge, userId);
      if (!wsPathSpeak) {
        await interaction.reply({ content: '你尚未註冊，請先使用 `/connection <邀請碼>` 註冊。', ephemeral: true });
        return;
      }

      const normalWs = resolve(wsPathSpeak);
      const notePath = resolve(normalWs, note);
      if (notePath !== normalWs && !notePath.startsWith(normalWs + sep)) {
        await interaction.reply({ content: '路徑不合法。', ephemeral: true });
        return;
      }

      const noteExt = extname(notePath).toLowerCase();
      if (!['.md', '.markdown', '.txt'].includes(noteExt)) {
        await interaction.reply({ content: '只能朗讀 .md / .markdown / .txt 筆記檔案。', ephemeral: true });
        return;
      }

      if (!fs.existsSync(notePath) || !fs.statSync(notePath).isFile()) {
        await interaction.reply({ content: `找不到筆記：\`${note}\``, ephemeral: true });
        return;
      }

      await interaction.deferReply();

      try {
        const markdown = fs.readFileSync(notePath, 'utf-8');
        const speechText = toSpeechText(markdown);

        if (!speechText.trim()) {
          await interaction.editReply('這份筆記轉換後沒有可朗讀的內容。');
          return;
        }

        log.info(`/speak from ${interaction.user.tag}: note=${note} provider=${process.env.TTS_PROVIDER || 'google'}`);

        const result = await tts.synthesize(speechText);
        const validBuffers = result.buffers.filter(Boolean);

        if (validBuffers.length === 0) {
          await interaction.editReply('語音轉換失敗，請稍後再試。');
          return;
        }

        const groups = groupBySize(validBuffers, MAX_DISCORD_FILE_SIZE);
        const merged = [];
        for (const group of groups) {
          merged.push(await mergeBuffers(group));
        }

        const baseName = basename(note, extname(note));
        const files = merged.map((buf, i) => ({
          attachment: buf,
          name: merged.length > 1 ? `${baseName}-part${i + 1}of${merged.length}.mp3` : `${baseName}.mp3`,
        }));

        const summaryLines = [`已將 \`${note}\` 轉換為語音`];
        if (merged.length > 1) summaryLines[0] += `（共 ${merged.length} 個檔案）`;
        if (result.truncated) summaryLines.push(`筆記過長，僅朗讀前 ${result.usedChunks} 段（共 ${result.totalChunks} 段）。`);
        if (result.errors.length > 0) summaryLines.push(`部分段落轉換失敗（${result.errors.length} 段），語音可能有缺漏。`);

        await interaction.editReply({ content: summaryLines.join('\n'), files });
        log.info(`/speak complete for ${interaction.user.tag}: ${files.length} file(s)`);
      } catch (err) {
        log.error(`/speak error for ${interaction.user.tag}: ${err.message}`);
        const errMsg = `語音轉換失敗：${err.message.slice(0, 200)}`;
        try {
          await interaction.editReply(errMsg);
        } catch {
          await interaction.user.send(errMsg).catch(() => {});
        }
      }
      return;
    }

    // --- /drive-sync: sync workspace to Google Drive (no AI, direct API) ---
    if (commandName === 'drive-sync') {
      const wsPath = wm.resolveWorkspace(bridge, userId);
      if (!wsPath) {
        await interaction.reply({ content: '你尚未註冊，請先使用 `/connection <邀請碼>` 註冊。', ephemeral: true });
        return;
      }
      if (!driveAuth.isConnected(wsPath)) {
        await interaction.reply({ content: 'Google Drive 尚未連接。請先使用 `/drive-connect` 授權。', ephemeral: true });
        return;
      }
      await interaction.deferReply({ ephemeral: true });
      try {
        const { uploaded, downloaded, total, errors, conflicts } = await driveAuth.syncToDrive(wsPath);
        const conflictNote = conflicts.length > 0 ? `\n⚡ ${conflicts.length} 個檔案有衝突，已自動合併（local 優先）：${conflicts.slice(0, 3).join(', ')}${conflicts.length > 3 ? '...' : ''}` : '';
        const errNote = errors.length > 0 ? `\n⚠️ ${errors.length} 個檔案失敗: ${errors.slice(0, 3).join(', ')}${errors.length > 3 ? '...' : ''}` : '';
        await interaction.editReply(`✓ 同步完成：↑${uploaded}/${total} 上傳，↓${downloaded} 從 Drive 下載。${conflictNote}${errNote}`);
      } catch (err) {
        log.error(`/drive-sync error for ${interaction.user.tag}: ${err.message}`);
        await interaction.editReply(`同步失敗：${err.message.slice(0, 200)}`);
      }
      return;
    }

    // --- /search: async semantic search over workspace embeddings ---
    if (commandName === 'search') {
      const query = interaction.options.getString('query');
      const wsPath = wm.resolveWorkspace(bridge, userId);
      if (!wsPath) {
        await interaction.reply({ content: '你尚未註冊，請先使用 `/connection <邀請碼>` 註冊。', ephemeral: true });
        return;
      }

      await interaction.deferReply({ ephemeral: true });

      try {
        const results = await searchWorkspace(wsPath, query);

        if (results.length === 0) {
          await interaction.editReply('沒有找到相關筆記。索引可能還在建立中，請稍後再試。');
          return;
        }

        const lines = [`🔍 搜尋「${query}」— 找到 ${results.length} 筆\n`];
        results.forEach((r, i) => {
          const pct = Math.round(r.score * 100);
          lines.push(`**${i + 1}. (${pct}%) ${r.title}**`);
          lines.push(`　📄 \`${r.path}\``);
        });

        await interaction.editReply(lines.join('\n'));
      } catch (err) {
        log.error(`/search error for ${interaction.user.tag}:`, err.message);
        await interaction.editReply('搜尋失敗，請稍後再試。');
      }
      return;
    }

    // Build args for command handler
    const args = [];
    if (commandName === 'connection') {
      args.push(interaction.options.getString('code'));
    } else if (commandName === 'bind') {
      args.push(interaction.options.getString('token'));
    } else if (commandName === 'todo') {
      const item = interaction.options.getString('item');
      if (item) args.push(item);
    } else if (commandName === 'list') {
      const listPath = interaction.options.getString('path');
      if (listPath) args.push(listPath);
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
      // Append server invite link for /share-code
      if (commandName === 'share-code' || commandName === 'sharecode') {
        try {
          // Find a text channel in any mutual guild to create an invite
          const guild = client.guilds.cache.find(g => g.members.cache.has(userId));
          if (guild) {
            const channel = guild.channels.cache.find(c => c.isTextBased() && !c.isThread() && c.permissionsFor(guild.members.me)?.has('CreateInstantInvite'));
            if (channel) {
              const invite = await channel.createInvite({ maxAge: 86400, maxUses: 1, unique: true });
              result.reply += `\n\nServer invite (24hr, one-time use):\n${invite.url}\n\nSend both to your friend — they join the server first, then use the invite code.`;
            }
          }
        } catch (err) {
          log.debug(`Could not create server invite: ${err.message}`);
        }
      }
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
          log.warn(`[SECURITY] Blocked command reply — pattern: ${sanitized.blockedBy} — matched: "${sanitized.matchedText}"`);
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

    // Resolve workspace — auto-register on first DM
    let wsPath = wm.resolveWorkspace(bridge, userId);
    if (!wsPath) {
      if (!isDM) return; // only auto-register via DM, not channel mentions
      const { wsPath: newPath } = wm.createWorkspace(bridge, userId);
      wsPath = newPath;
      log.info(`Auto-registered new user: ${bridge}:${userId}`);
    }

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
    const refContext = await fetchReferencedContent(message, wsPath);
    if (refContext) prompt = refContext + prompt;

    // Fetch all attachments — save to disk, append annotation
    const attachmentText = await fetchAttachments(message, uploadsDir);
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

    // Classify tier in parallel with typing indicator startup
    const tierPromise = classifyTier(fullPrompt);

    startTyping();

    // --- Progress message state ---
    // Set SHOW_PROGRESS=1 in .env to show tool progress in Discord
    const showProgress = process.env.SHOW_PROGRESS === '1';
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
        log.debug(`Tool [${progressSteps.length}]: ${event.name} — ${event.description}`);

        if (!showProgress) return;

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
        if (showProgress && progressMsg) {
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
        } else {
          // Fallback: inject recent talk-history so new session has some context
          const talkHistoryPath = join(wsPath, 'talk-history.jsonl');
          try {
            if (fs.existsSync(talkHistoryPath)) {
              const lines = fs.readFileSync(talkHistoryPath, 'utf-8').trim().split('\n');
              const recent = lines.slice(-5).map(l => {
                try {
                  const { u, a } = JSON.parse(l);
                  return `User: ${u}\nAssistant: ${a}`;
                } catch { return null; }
              }).filter(Boolean).join('\n\n');
              if (recent) {
                fullPrompt = `[Recent conversation history (session was rotated):\n${recent}]\n\n${fullPrompt}`;
                log.info(`Compact fallback: injected ${lines.slice(-5).length} talk-history entries`);
              }
            }
          } catch (err) {
            log.warn(`Compact fallback failed: ${err.message}`);
          }
        }
      } else {
        const existingSession = sessions.get(key);
        isResume = !!existingSession;
        sessionId = sessions.getOrCreate(key);
      }

      const tier = await tierPromise;
      const model = TIER_MODELS[tier];
      log.info(`Request from ${message.author.tag} [${key}] resume=${isResume} ws=${wsPath} tier=${tier} model=${model}`);
      let result;
      try {
        result = await enqueue(fullPrompt, sessionId, isResume, onProgress, wsPath, model);
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

      let responseText = result.text || '';

      // Replace web access markers with actual URLs
      const wsRel = wm.readIndex('discord', userId);
      if (wsRel) {
        // [REQUEST_WEB_ACCESS] → dashboard root
        responseText = responseText.replace(/\[REQUEST_WEB_ACCESS\]/g, webBridge.generateAccessUrl(wsRel));
        // [REQUEST_WEB_FILE:path] → deep link to specific file
        responseText = responseText.replace(/\[REQUEST_WEB_FILE:([^\]]+)\]/g, (_, filePath) => {
          return webBridge.generateAccessUrl(wsRel, filePath.trim());
        });
      } else {
        responseText = responseText.replace(/\[REQUEST_WEB_ACCESS\]/g, '(web dashboard unavailable)');
        responseText = responseText.replace(/\[REQUEST_WEB_FILE:[^\]]+\]/g, '(web dashboard unavailable)');
      }

      // Append to talk-history for seed-watering trigger
      wm.appendTalkHistory(wsPath, prompt, responseText);

      // Track engagement — check if this user message is a reply to a job-initiated DM
      if (isDM) {
        try {
          engagement.matchReply(wsPath, {
            channelId: `dm:discord:${userId}`,
            responseLength: prompt.length,
            responseText: prompt,
          });
        } catch (engErr) {
          log.debug(`Engagement match failed: ${engErr.message}`);
        }
      }

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
      const limit = parseInt(process.env.COMPACT_THRESHOLD || '180000', 10);
      const pct = ((result.inputTokens / limit) * 100).toFixed(1);
      const tokenInfo = `⛁ ${fmtTokens(result.inputTokens)} (${pct}%)`;
      const withFooter = responseText + `\n\n-# ⎔ ${shortId} · ${tokenInfo}`;
      const chunks = splitMessage(withFooter);
      const sentIds = [];
      for (let i = 0; i < chunks.length; i++) {
        const sanitized = sanitizeOutput(chunks[i], wsPath);
        if (!sanitized.safe) {
          log.warn(`[SECURITY] Blocked response chunk ${i} — pattern: ${sanitized.blockedBy} — matched: "${sanitized.matchedText}"`);
          await message.channel.send('Response blocked: contained restricted information.');
          break;
        }
        // Attach outbox files to the last chunk
        const isLast = i === chunks.length - 1;
        let sent;
        if (isLast && outboxFiles.length) {
          sent = await message.channel.send({ content: sanitized.text, files: outboxFiles });
        } else {
          sent = await message.channel.send(sanitized.text);
        }
        sentIds.push(sent.id);
      }
      if (sentIds.length > 1) saveMessageGroup(wsPath, sentIds).catch(err => log.warn(`Failed to save message group: ${err.message}`));
    } catch (err) {
      stopTyping();
      if (pendingEdit) clearTimeout(pendingEdit);
      if (showProgress && progressMsg) {
        const failed = `❌ Failed · ${progressSteps.length} steps\n-# ${categoryStats()}`;
        progressMsg.edit(failed).catch(() => {});
      }
      log.error(`Error handling message from ${message.author.tag}:`, err.message);
      const errSanitized = sanitizeOutput(`Something went wrong: ${err.message.slice(0, 200)}`, wsPath);
      await message.channel.send(errSanitized.safe ? errSanitized.text : 'Something went wrong.').catch(() => {});
    }
  });

  // --- Welcome DM for new server members ---
  client.on('guildMemberAdd', async (member) => {
    if (member.user.bot) return;

    const isRegistered = !!wm.readIndex('discord', member.user.id);

    try {
      const dm = await member.createDM();
      if (isRegistered) {
        await dm.send(`Hey! Welcome to **${member.guild.name}** 👋`);
      } else {
        await dm.send(
          `Hey! Welcome to **${member.guild.name}** 👋\n\n` +
          `I'm **Synapsis** — an AI companion that grows with you.\n\n` +
          `To get started, you'll need an invite code from someone who's already here. ` +
          `Once you have one, send me:\n` +
          `\`/connection <your-invite-code>\`\n\n` +
          `Type \`/help\` to see all available commands.`
        );
      }
      log.info(`Welcome DM sent to ${member.user.tag} (registered=${isRegistered})`);
    } catch (err) {
      log.debug(`Could not send welcome DM to ${member.user.tag}: ${err.message}`);
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
      GatewayIntentBits.GuildMembers,
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
