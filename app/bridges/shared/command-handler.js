const path = require('path');
const { createLogger } = require('./logger');
const log = createLogger('commands', {
  logDir: process.env.LOG_DIR || path.join(__dirname, '..', '..', 'logs'),
});
const fs = require('fs');
const wm = require('./workspace-manager');
const webBridge = require('../web/src/index');
const driveAuth = require('./drive-auth');
const { extractKeywords } = require('./keyword-extract');

const TODO_FILE = 'TODO.md';

// Rate limit: /connection attempts per user
const connectionAttempts = new Map(); // `${bridge}:${userId}` → { count, resetAt }
const CONNECTION_RATE_LIMIT = 5;
const CONNECTION_RATE_WINDOW = 10 * 60 * 1000; // 10 minutes

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function checkConnectionRate(bridge, userId) {
  const key = `${bridge}:${userId}`;
  const now = Date.now();
  const entry = connectionAttempts.get(key);

  if (!entry || now > entry.resetAt) {
    connectionAttempts.set(key, { count: 1, resetAt: now + CONNECTION_RATE_WINDOW });
    return true;
  }

  if (entry.count >= CONNECTION_RATE_LIMIT) {
    return false;
  }

  entry.count++;
  return true;
}

/**
 * Parse a command from message text.
 * Returns { command, args } or null if not a command.
 */
function parseCommand(text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;

  const parts = trimmed.split(/\s+/);
  const command = parts[0].slice(1).toLowerCase(); // remove "/"
  const args = parts.slice(1);
  return { command, args };
}

/**
 * Handle a parsed command.
 *
 * @param {string} bridge - Bridge name (e.g. 'discord')
 * @param {string} userId - User ID on that bridge
 * @param {object} parsed - { command, args }
 * @param {object} context - { sessions, resetSessionKey }
 * @returns {{ reply: string, ephemeral?: boolean } | null}
 */
function handleCommand(bridge, userId, parsed, context) {
  const { command, args } = parsed;
  const isRegistered = !!wm.readIndex(bridge, userId);

  switch (command) {
    case 'connection': {
      if (isRegistered) {
        return { reply: 'You are already registered.', ephemeral: true };
      }

      const code = args[0];
      if (!code) {
        return { reply: 'Usage: /connection <invite-code>', ephemeral: true };
      }

      if (!checkConnectionRate(bridge, userId)) {
        return { reply: 'Too many attempts. Please try again later.', ephemeral: true };
      }

      const invite = wm.consumeInvite(code);
      if (!invite) {
        return { reply: 'Invalid or expired invite code.', ephemeral: true };
      }

      const { wsPath } = wm.createWorkspace(bridge, userId);
      log.info(`New user registered: ${bridge}:${userId} via invite from ${invite.from}`);
      return { reply: 'Registration complete! Send me a message to get started.' };
    }

    case 'share-code':
    case 'sharecode': {
      if (!isRegistered) {
        return { reply: 'You must be registered to use this command.', ephemeral: true };
      }

      const wsRel = wm.readIndex(bridge, userId);
      const code = wm.createInvite(wsRel);
      return {
        reply: `Your invite code (24hr, one-time use):\n\`${code}\`\n\nShare this with the person you want to invite. They use: \`/connection ${code}\``,
        ephemeral: true,
      };
    }

    case 'bind-token':
    case 'bindtoken': {
      if (!isRegistered) {
        return { reply: 'You must be registered to use this command.', ephemeral: true };
      }

      const wsRel = wm.readIndex(bridge, userId);
      const token = wm.createBindToken(wsRel);
      return {
        reply: `Your bind token (5 min, one-time use):\n\`${token}\`\n\nOn your other bridge account, use: \`/bind ${token}\``,
        ephemeral: true,
      };
    }

    case 'bind': {
      const token = args[0];
      if (!token) {
        return { reply: 'Usage: /bind <token>', ephemeral: true };
      }

      if (isRegistered) {
        return { reply: 'This account is already bound to a workspace.', ephemeral: true };
      }

      const tokenData = wm.consumeBindToken(token);
      if (!tokenData) {
        return { reply: 'Invalid or expired bind token.', ephemeral: true };
      }

      const success = wm.bindAccount(bridge, userId, tokenData.workspaceId);
      if (!success) {
        return { reply: 'Failed to bind account. Workspace not found.', ephemeral: true };
      }

      log.info(`Account bound: ${bridge}:${userId} → ${tokenData.workspaceId}`);
      return { reply: 'Binding complete! You now share the same workspace.' };
    }

    case 'new':
    case 'reset': {
      if (!isRegistered) {
        return { reply: 'You must be registered to use this command.', ephemeral: true };
      }

      if (context && context.resetSessionKey) {
        context.resetSessionKey();
      }
      return { reply: 'New conversation started.' };
    }

    case 'commons': {
      const url = webBridge.getCommonsUrl();
      return { reply: `Soul Commons — read what the souls are thinking:\n${url}` };
    }

    case 'dashboard':
    case 'dash':
    case 'files': {
      if (!isRegistered) {
        return { reply: 'You must be registered to use this command.', ephemeral: true };
      }

      const wsRel = wm.readIndex(bridge, userId);
      if (!wsRel) {
        return { reply: 'Workspace not found.', ephemeral: true };
      }

      const url = webBridge.generateAccessUrl(wsRel);
      return { reply: `Here's your dashboard link (30 min):\n${url}`, ephemeral: true };
    }

    case 'todo': {
      if (!isRegistered) {
        return { reply: 'You must be registered to use this command.', ephemeral: true };
      }

      const wsPath = wm.resolveWorkspace(bridge, userId);
      if (!wsPath) {
        return { reply: 'Workspace not found.', ephemeral: true };
      }

      const todoPath = path.join(wsPath, TODO_FILE);
      const item = args.join(' ').trim();

      if (!item) {
        // List todos
        try {
          if (!fs.existsSync(todoPath)) {
            return { reply: 'No todos yet. Add one with `/todo something`', ephemeral: true };
          }
          const content = fs.readFileSync(todoPath, 'utf-8').trim();
          if (!content) {
            return { reply: 'No todos yet. Add one with `/todo something`', ephemeral: true };
          }
          return { reply: content, ephemeral: true };
        } catch {
          return { reply: 'Failed to read todos.', ephemeral: true };
        }
      }

      // Add todo
      try {
        const line = `- [ ] ${item}\n`;
        if (!fs.existsSync(todoPath)) {
          fs.writeFileSync(todoPath, `# TODO\n\n${line}`);
        } else {
          fs.appendFileSync(todoPath, line);
        }
        return { reply: `Added: ${item}`, ephemeral: true };
      } catch {
        return { reply: 'Failed to add todo.', ephemeral: true };
      }
    }

    case 'list': {
      if (!isRegistered) {
        return { reply: 'You must be registered to use this command.', ephemeral: true };
      }

      const wsPath = wm.resolveWorkspace(bridge, userId);
      if (!wsPath) {
        return { reply: 'Workspace not found.', ephemeral: true };
      }

      const subPath = (args[0] || '').trim().replace(/\/+$/, '');
      const filterKw = (args[1] || '').trim();
      const flags = args.slice(2);
      const showCount = flags.includes('--count');
      const showKeywords = flags.includes('--keywords');

      const normalWs = path.resolve(wsPath);
      const targetPath = path.resolve(normalWs, subPath);
      if (targetPath !== normalWs && !targetPath.startsWith(normalWs + path.sep)) {
        return { reply: '路徑不合法。', ephemeral: true };
      }

      const displayPath = subPath ? `/${subPath}` : '/';

      if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isDirectory()) {
        return { reply: `找不到資料夾：\`${displayPath}\``, ephemeral: true };
      }

      let entries;
      try {
        entries = fs.readdirSync(targetPath, { withFileTypes: true })
          .filter(e => !e.name.startsWith('.'));
      } catch {
        return { reply: '讀取資料夾失敗。', ephemeral: true };
      }

      let dirs = entries.filter(e => e.isDirectory()).map(e => e.name).sort();
      let files = entries.filter(e => e.isFile()).map(e => e.name).sort();

      if (filterKw) {
        const filterRe = new RegExp(escapeRegExp(filterKw), 'i');
        dirs = dirs.filter(name => filterRe.test(name));
        files = files.filter(name => filterRe.test(name));
      }

      const total = dirs.length + files.length;
      const matchSuffix = filterKw ? `，符合「${filterKw}」` : '';

      if (!total) {
        const suffix = filterKw ? `，沒有符合「${filterKw}」的項目` : ' 是空的';
        return { reply: `📁 \`${displayPath}\`${suffix}`, ephemeral: true };
      }

      const keywordLine = () => {
        const keywords = extractKeywords([...dirs, ...files]);
        return keywords.length
          ? `🔑 關鍵字：${keywords.map(k => `${k.term} (${k.count})`).join('、')}`
          : null;
      };

      if (showCount) {
        let reply = `📁 \`${displayPath}\`：${total} 項${matchSuffix}（${dirs.length} 資料夾、${files.length} 檔案）`;
        if (showKeywords) {
          const kwLine = keywordLine();
          if (kwLine) reply += `\n${kwLine}`;
        }
        return { reply, ephemeral: true };
      }

      // Each path is its own inline-code span (no spaces inside) so it can be
      // tapped/double-tapped and copied individually on mobile, separate from
      // the emoji/size annotation around it. Paths are full relative paths,
      // directly usable as input to /list path: or /speak note: — unless a
      // filter keyword is highlighted with [brackets] inside the span.
      const highlight = (name) => filterKw
        ? name.replace(new RegExp(escapeRegExp(filterKw), 'gi'), m => `[${m}]`)
        : name;

      const lines = [`📁 \`${displayPath}\`（${total} 項${matchSuffix}）`, ''];
      for (const name of dirs) {
        const rel = subPath ? `${subPath}/${name}` : name;
        lines.push(`📂 \`${highlight(rel)}/\``);
      }
      for (const name of files) {
        const rel = subPath ? `${subPath}/${name}` : name;
        const size = fs.statSync(path.join(targetPath, name)).size;
        lines.push(`📄 \`${highlight(rel)}\`  (${formatFileSize(size)})`);
      }

      if (showKeywords) {
        const kwLine = keywordLine();
        if (kwLine) {
          lines.push('');
          lines.push(kwLine);
        }
      }

      let reply = lines.join('\n');
      if (reply.length > 1900) {
        reply = `${reply.slice(0, 1900)}\n...（項目過多，已截斷）`;
      }

      return { reply, ephemeral: true };
    }

    case 'drive-connect':
    case 'driveconnect': {
      if (!isRegistered) {
        return { reply: 'You must be registered to use this command.', ephemeral: true };
      }
      if (!driveAuth.isConfigured()) {
        return { reply: 'Google Drive is not configured on this server. Contact the administrator.', ephemeral: true };
      }
      if (!process.env.WEB_PORT && !process.env.WEB_ENABLED) {
        return { reply: 'Google Drive sync requires the web dashboard to be enabled (set WEB_PORT in .env).', ephemeral: true };
      }
      const wsRel = wm.readIndex(bridge, userId);
      const url = driveAuth.getAuthUrl(wsRel);
      return {
        reply: `**Connect Google Drive** (link expires after use):\n${url}\n\nOpen the link in your browser to authorize. Once connected, ask your AI companion to manage or sync files to Drive.`,
        ephemeral: true,
      };
    }

    case 'help': {
      const lines = [
        '**Available commands:**',
        '`/help` — Show this list',
        '`/new` or `/reset` — Start a new conversation',
        '`/search <query>` — 語意搜尋 workspace 所有筆記',
        '`/dashboard` — Open file manager',
        '`/list [path] [filter] [count] [keywords]` — 列出 workspace 資料夾內容（可篩選關鍵字、只顯示數量、或萃取常見關鍵字）',
        '`/commons` — Soul Commons (public — read what the souls are thinking)',
        '`/todo` — List todos',
        '`/todo <item>` — Add a todo',
        '`/yt <video>` — YouTube 逐字稿分析',
        '`/yt <video> verify:true` — 逐字稿 + 驗證探索',
        '`/speak <note>` — 將筆記轉成語音',
        '`/drive-connect` — 連接 Google Drive',
        '`/drive-sync` — 同步 workspace 到 Google Drive',
        '`/connection <code>` — Register with an invite code',
        '`/share-code` — Generate a 24hr one-time invite code',
        '`/bind-token` — Generate a 5-min token for cross-platform binding',
        '`/bind <token>` — Bind this account to an existing workspace',
      ];
      return { reply: lines.join('\n'), ephemeral: true };
    }

    default:
      return null; // Unknown command — not handled
  }
}

module.exports = { parseCommand, handleCommand };
