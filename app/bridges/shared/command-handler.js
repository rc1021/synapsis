const path = require('path');
const { createLogger } = require('./logger');
const log = createLogger('commands', {
  logDir: process.env.LOG_DIR || path.join(__dirname, '..', '..', 'logs'),
});
const fs = require('fs');
const wm = require('./workspace-manager');
const webBridge = require('../web/src/index');

const TODO_FILE = 'TODO.md';

// Rate limit: /connection attempts per user
const connectionAttempts = new Map(); // `${bridge}:${userId}` → { count, resetAt }
const CONNECTION_RATE_LIMIT = 5;
const CONNECTION_RATE_WINDOW = 10 * 60 * 1000; // 10 minutes

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

    case 'help': {
      const lines = [
        '**Available commands:**',
        '`/help` — Show this list',
        '`/new` or `/reset` — Start a new conversation',
        '`/dashboard` — Open file manager',
        '`/todo` — List todos',
        '`/todo <item>` — Add a todo',
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
