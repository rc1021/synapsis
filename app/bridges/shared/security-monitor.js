/**
 * Security violation detector & tracker.
 *
 * Monitors Claude tool calls for workspace escape attempts:
 *   - Path traversal (../ or absolute paths outside workspace)
 *   - Symlink creation
 *   - Bash usage for file access
 *
 * Tracks per-workspace violation counts and escalates:
 *   1-2 violations  -> log + warning file in workspace
 *   3-5 violations  -> notify admin via Discord DM
 *   6+  violations  -> notify admin + flag for session kill
 */
const fs = require('fs');
const path = require('path');
const { createLogger } = require('./logger');
const log = createLogger('security', {
  logDir: process.env.LOG_DIR || require('path').join(__dirname, '..', '..', 'logs'),
});

// In-memory violation counters: wsPath -> { count, events[] }
const violations = new Map();

// Admin user ID for notifications (set via init or env)
let adminUserId = process.env.SECURITY_ADMIN_ID || '';
let notifyFn = null; // (userId, message) => Promise<void>

function init({ adminId, sendDM } = {}) {
  if (adminId) adminUserId = adminId;
  if (sendDM) notifyFn = sendDM;
}

// --- Detection patterns ---

const TRAVERSAL_RE = /\.\.\//;
const SYMLINK_TOOLS = /^(Bash)$/i;
const SYMLINK_CMD_RE = /\bln\s+-s\b/;

/**
 * Check a tool call for security violations.
 * @param {string} toolName  - e.g. 'Read', 'Glob', 'Bash'
 * @param {object} toolInput - parsed JSON input to the tool
 * @param {string} wsPath    - workspace absolute path (the allowed CWD)
 * @returns {{ violation: boolean, reason: string }|null}
 */
function checkToolCall(toolName, toolInput, wsPath) {
  if (!wsPath) return null;

  const normalWs = path.resolve(wsPath);
  const pathFields = ['file_path', 'path', 'directory'];

  // 1. Check path fields for traversal / escape
  for (const field of pathFields) {
    const val = toolInput[field];
    if (typeof val !== 'string') continue;

    // Resolve against workspace to see where it actually points
    const resolved = path.resolve(normalWs, val);
    if (!resolved.startsWith(normalWs + path.sep) && resolved !== normalWs) {
      return {
        violation: true,
        reason: `path escape via ${field}: "${val}" resolves to "${resolved}" (outside workspace)`,
      };
    }

    // Explicit traversal pattern (even if technically still inside)
    if (TRAVERSAL_RE.test(val) && !resolved.startsWith(normalWs)) {
      return {
        violation: true,
        reason: `path traversal in ${field}: "${val}"`,
      };
    }
  }

  // 2. Glob pattern check
  if (toolName === 'Glob' && typeof toolInput.pattern === 'string') {
    if (TRAVERSAL_RE.test(toolInput.pattern)) {
      return {
        violation: true,
        reason: `glob pattern traversal: "${toolInput.pattern}"`,
      };
    }
  }

  // 3. Bash symlink creation
  if (SYMLINK_TOOLS.test(toolName)) {
    const cmd = toolInput.command || toolInput.script || '';
    if (SYMLINK_CMD_RE.test(cmd)) {
      return {
        violation: true,
        reason: `symlink creation attempt: "${cmd.slice(0, 100)}"`,
      };
    }
  }

  // 4. Bash cat/find targeting outside workspace
  if (toolName === 'Bash') {
    const cmd = toolInput.command || '';
    // Simple heuristic: absolute paths not starting with workspace
    const absPathMatch = cmd.match(/(?:cat|head|tail|find|ls|less|more)\s+(\/\S+)/);
    if (absPathMatch) {
      const target = absPathMatch[1];
      if (!target.startsWith(normalWs)) {
        return {
          violation: true,
          reason: `bash file access outside workspace: "${cmd.slice(0, 100)}"`,
        };
      }
    }
  }

  return null;
}

/**
 * Record a violation and handle escalation.
 */
async function recordViolation(wsPath, toolName, reason) {
  if (!violations.has(wsPath)) {
    violations.set(wsPath, { count: 0, events: [] });
  }

  const record = violations.get(wsPath);
  record.count++;
  const event = {
    time: new Date().toISOString(),
    tool: toolName,
    reason,
    count: record.count,
  };
  record.events.push(event);

  // Keep only last 20 events
  if (record.events.length > 20) {
    record.events = record.events.slice(-20);
  }

  log.warn(`[SECURITY] Violation #${record.count} in ${wsPath}: ${reason}`);

  // Escalation tiers
  if (record.count <= 2) {
    await writeWarningFile(wsPath, record);
  } else if (record.count <= 5) {
    await writeWarningFile(wsPath, record);
    await notifyAdmin(wsPath, event);
  } else {
    await writeWarningFile(wsPath, record);
    await notifyAdmin(wsPath, event, true);
  }

  return record.count;
}

/**
 * Write a friendly warning file inside the workspace.
 */
async function writeWarningFile(wsPath, record) {
  try {
    const filePath = path.join(wsPath, 'SECURITY_WARNING.md');
    const content = [
      '# Security Warning',
      '',
      `> Auto-generated at ${new Date().toISOString()}`,
      '',
      `**${record.count} security violation(s) detected in this workspace.**`,
      '',
      'The following actions were blocked because they attempted to access files outside the workspace boundary:',
      '',
      ...record.events.slice(-5).map(e =>
        `- \`${e.time}\` — **${e.tool}**: ${e.reason}`
      ),
      '',
      '---',
      '',
      'Please follow the workspace safety rules:',
      '- Do not read or write files outside this directory',
      '- Do not create symlinks',
      '- Do not use shell commands to access external paths',
      '',
      `Violation count resets when the service restarts. Current count: **${record.count}**`,
    ].join('\n');

    fs.writeFileSync(filePath, content, 'utf8');
    log.info(`[SECURITY] Warning file written to ${filePath}`);
  } catch (err) {
    log.error(`[SECURITY] Failed to write warning file: ${err.message}`);
  }
}

/**
 * Notify admin via Discord DM.
 */
async function notifyAdmin(wsPath, event, critical = false) {
  if (!notifyFn || !adminUserId) {
    log.warn('[SECURITY] Cannot notify admin: no sendDM function or admin ID configured');
    return;
  }

  const prefix = critical ? '[CRITICAL]' : '[WARNING]';
  const message = [
    `${prefix} Security violation #${event.count}`,
    `Workspace: \`${path.basename(wsPath)}\``,
    `Tool: **${event.tool}**`,
    `Reason: ${event.reason}`,
    `Time: ${event.time}`,
    critical ? '\nRecommendation: Consider terminating this session.' : '',
  ].filter(Boolean).join('\n');

  try {
    await notifyFn(adminUserId, message);
    log.info(`[SECURITY] Admin notified: violation #${event.count}`);
  } catch (err) {
    log.error(`[SECURITY] Failed to notify admin: ${err.message}`);
  }
}

/**
 * Get current violation count for a workspace.
 */
function getViolationCount(wsPath) {
  return violations.get(wsPath)?.count || 0;
}

/**
 * Check if workspace should be killed (6+ violations).
 */
function shouldKillSession(wsPath) {
  return getViolationCount(wsPath) >= 6;
}

/**
 * Reset violations for a workspace.
 */
function resetViolations(wsPath) {
  violations.delete(wsPath);
}

module.exports = {
  init,
  checkToolCall,
  recordViolation,
  getViolationCount,
  shouldKillSession,
  resetViolations,
};
