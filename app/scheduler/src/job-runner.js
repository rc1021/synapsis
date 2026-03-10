const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const { resolve, join } = require('path');
const log = require('./logger');
const { shouldNotify, sendNotification, notifyAllBindings } = require('./notifier');
const registry = require('../../bridges/shared/providers/registry');
const { BASE_RULES } = require('../../bridges/shared/system-prompt');
const wm = require('../../bridges/shared/workspace-manager');
const { sanitizeOutput, isTextFile } = require('../../bridges/shared/sanitize');
const { buildMcpConfig } = require('../../bridges/shared/mcp-config');

const OUTBOX_DIR = 'outbox';
const MAX_OUTBOX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const SOUL_REFLECTION_STATE_PATH = join(__dirname, '..', '..', '.soul-reflection-state.json');

const PROJECT_DIR = process.env.PROJECT_DIR || resolve(join(__dirname, '../..'));
const SHARED_SOUL_PATH = join(__dirname, '..', '..', 'SOUL.md');

let _sharedSoul = '';
try {
  _sharedSoul = fs.readFileSync(SHARED_SOUL_PATH, 'utf-8');
} catch (err) {
  log.warn(`Failed to load shared SOUL.md: ${err.message}`);
}

const SCHEDULER_RULES = [
  'IMPORTANT: Your final action must always be a text output, never a tool call. The text output is captured as the job result.',
];

const SYSTEM_PROMPT = [...SCHEDULER_RULES, ...BASE_RULES];

// Concurrency lock: prevent same job from overlapping
const running = new Set();

function isRunning(jobId) {
  return running.has(jobId);
}

/**
 * Collect files from workspace outbox/ directory for attachment.
 * Returns array of { attachment: Buffer, name: string } and cleans up.
 */
function collectOutbox(wsAbsPath) {
  const outboxPath = join(wsAbsPath, OUTBOX_DIR);
  if (!fs.existsSync(outboxPath)) return [];

  const files = [];
  try {
    for (const name of fs.readdirSync(outboxPath)) {
      const filePath = join(outboxPath, name);
      const stat = fs.statSync(filePath);
      if (!stat.isFile() || stat.size === 0) continue;
      if (stat.size > MAX_OUTBOX_FILE_SIZE) {
        log.warn(`Outbox file "${name}" too large (${(stat.size / 1024 / 1024).toFixed(1)}MB), skipping`);
        continue;
      }

      if (isTextFile(name)) {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const sanitized = sanitizeOutput(raw, wsAbsPath);
        if (!sanitized.safe) {
          log.warn(`[SECURITY] Outbox file "${name}" blocked — infrastructure leak detected`);
          continue;
        }
        files.push({ attachment: Buffer.from(sanitized.text, 'utf-8'), name });
      } else {
        files.push({ attachment: fs.readFileSync(filePath), name });
      }
    }
    // Clean up
    for (const name of fs.readdirSync(outboxPath)) {
      fs.unlinkSync(join(outboxPath, name));
    }
    fs.rmdirSync(outboxPath);
  } catch (err) {
    log.warn(`Failed to collect outbox: ${err.message}`);
  }
  return files;
}

function isQuietHour(job) {
  if (!job.quietHours) return false;
  const hour = new Date().getHours();
  const { start, end } = job.quietHours;
  // Handle wrap-around (e.g. 23 → 8)
  if (start > end) {
    return hour >= start || hour < end;
  }
  return hour >= start && hour < end;
}

/**
 * Simple line-based diff: returns only added/changed lines between old and new content.
 * Not a full unified diff — just enough for the AI to see what's new.
 */
function simpleDiff(oldText, newText) {
  const oldLines = new Set(oldText.split('\n').map(l => l.trim()).filter(Boolean));
  const newLines = newText.split('\n');
  const added = [];
  for (const line of newLines) {
    if (!oldLines.has(line.trim()) && line.trim()) {
      added.push(line);
    }
  }
  return added;
}

/**
 * Collect per-workspace SOUL.md changes since last soul-reflection run.
 *
 * Strategy: store a content hash snapshot per workspace after each run.
 * Next run: compare current content hash → unchanged = skip, changed = compute diff.
 * First-time souls (no previous snapshot) get sent in full.
 *
 * Returns formatted string for {{CHANGED_SOULS}} template variable.
 * Updates snapshot after collection.
 */
function collectChangedSouls() {
  const dataDir = join(PROJECT_DIR, 'workspaces', 'data');
  if (!fs.existsSync(dataDir)) return '(No workspaces found.)';

  // Load previous snapshots: { snapshots: { anonymousId: { hash, content } }, ... }
  let prevSnapshots = {};
  try {
    const state = JSON.parse(fs.readFileSync(SOUL_REFLECTION_STATE_PATH, 'utf-8'));
    prevSnapshots = state.snapshots || {};
  } catch {
    // First run
  }

  const newEntries = [];   // First-time souls (full content)
  const diffEntries = [];  // Changed souls (diff only)
  const nextSnapshots = {};
  let totalUnchanged = 0;

  // Use a stable anonymous index (not workspace ID) for snapshot keys
  const wsDirs = fs.readdirSync(dataDir).sort();
  for (let i = 0; i < wsDirs.length; i++) {
    const wsDir = wsDirs[i];
    const soulPath = join(dataDir, wsDir, 'SOUL.md');
    // Use a hash of wsDir as anonymous key (not the wsDir itself, for privacy)
    const anonKey = crypto.createHash('sha256').update(wsDir).digest('hex').slice(0, 12);

    try {
      const stat = fs.statSync(soulPath);
      if (!stat.isFile()) continue;

      const content = fs.readFileSync(soulPath, 'utf-8').trim();

      // Skip unmodified template files
      if (content.includes('_(尚未定義') && !content.includes('## 關係\n\n_')) {
        totalUnchanged++;
        continue;
      }

      const hash = crypto.createHash('sha256').update(content).digest('hex');

      // Save snapshot for next run (store content for future diff)
      nextSnapshots[anonKey] = { hash, content };

      const prev = prevSnapshots[anonKey];
      if (prev && prev.hash === hash) {
        // Content identical — skip
        totalUnchanged++;
        continue;
      }

      if (!prev) {
        // First time seeing this soul — send full content
        newEntries.push(content);
      } else {
        // Changed — compute diff
        const addedLines = simpleDiff(prev.content, content);
        if (addedLines.length === 0) {
          // Only deletions/reordering, no new content — skip
          totalUnchanged++;
          continue;
        }
        diffEntries.push(addedLines.join('\n'));
      }
    } catch (err) {
      log.debug(`Skipping soul in ${wsDir}: ${err.message}`);
    }
  }

  // Persist snapshots
  try {
    fs.writeFileSync(SOUL_REFLECTION_STATE_PATH, JSON.stringify({
      lastRunISO: new Date().toISOString(),
      snapshots: nextSnapshots,
    }, null, 2));
  } catch (err) {
    log.warn(`Failed to save soul-reflection state: ${err.message}`);
  }

  const totalChanged = newEntries.length + diffEntries.length;

  if (totalChanged === 0) {
    return `(No per-SOUL changes since last reflection. ${totalUnchanged} workspace(s) unchanged.)`;
  }

  const parts = [];
  parts.push(`${totalChanged} per-SOUL(s) changed since last reflection (${totalUnchanged} unchanged):\n`);

  let idx = 1;
  for (const content of newEntries) {
    parts.push(`--- Per-SOUL ${idx} (first reflection, full content) ---\n${content}`);
    idx++;
  }
  for (const diff of diffEntries) {
    parts.push(`--- Per-SOUL ${idx} (new/changed lines only) ---\n${diff}`);
    idx++;
  }

  return parts.join('\n\n');
}

function templateReplace(str, job) {
  const now = new Date();
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const timestamp = `${now.toISOString()} (${days[now.getDay()]})`;
  let result = str.replace(/\{\{TIMESTAMP\}\}/g, timestamp);
  if (job && job._specContent) {
    result = result.replace(/\{\{SPEC\}\}/g, job._specContent);
  }
  if (job && job._talkHistory) {
    result = result.replace(/\{\{TALK_HISTORY\}\}/g, job._talkHistory);
  }
  if (result.includes('{{CHANGED_SOULS}}')) {
    result = result.replace(/\{\{CHANGED_SOULS\}\}/g, collectChangedSouls());
  }
  return result;
}

function runShell(job) {
  const command = job.shell?.command;
  if (!command) {
    return Promise.reject(new Error(`Shell job ${job.id} has no command`));
  }

  const timeout = job.timeout || 60000;

  return new Promise((resolve, reject) => {
    const child = spawn('bash', ['-c', command], {
      cwd: PROJECT_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      log.warn(`Shell job ${job.id} timeout (${timeout}ms), killing`);
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000);
    }, timeout);

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Shell exited ${code}: ${stderr.slice(0, 500)}`));
      } else {
        resolve(stdout.trim());
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function runAI(job) {
  // Support both new "ai" key and legacy "claude" key
  const config = job.ai || job.claude;
  if (!config) {
    throw new Error(`AI job ${job.id} has no ai/claude config`);
  }

  const prompt = templateReplace(config.prompt, job);
  const timeout = job.timeout || 120000;
  const provider = registry.get();

  // Support custom systemPrompt from job config (for soul-evolution jobs etc.)
  const systemParts = config.systemPrompt
    ? [config.systemPrompt]
    : [...SYSTEM_PROMPT];

  // System jobs get system-level MCP only (no per-workspace)
  const mcp = buildMcpConfig(null);
  const mergedAllowedTools = config.allowedTools
    ? [...config.allowedTools, ...mcp.toolPatterns]
    : config.allowedTools;

  log.info(`AI spawn for job ${job.id}: provider=${provider.name} model=${config.model || 'default'} mcp=${mcp.toolPatterns.join(',') || 'none'}`);

  try {
    const result = await provider.run({
      prompt,
      model: config.model,
      allowedTools: mergedAllowedTools,
      disallowedTools: config.disallowedTools,
      maxBudgetUsd: config.maxBudgetUsd,
      systemPrompt: systemParts.join(' '),
      cwd: PROJECT_DIR,
      timeout,
      mcpConfigPath: mcp.configPath,
    });

    const text = result.text || '';
    if (!text) {
      const raw = result.raw || {};
      const cost = raw.total_cost_usd ? `$${raw.total_cost_usd.toFixed(2)}` : 'unknown';
      const turns = raw.num_turns || '?';
      const stopReason = raw.stop_reason || 'unknown';
      log.warn(`AI job ${job.id} returned empty result (stop_reason=${stopReason}, turns=${turns}, cost=${cost})`);
      return `⚠️ Job completed but returned empty result.\nTurns: ${turns} | Cost: ${cost} | Stop reason: ${stopReason}`;
    }

    return String(text);
  } catch (err) {
    log.error(`AI job ${job.id} failed: ${err.message}`);
    throw err;
  }
}

async function runJob(job) {
  // Concurrency check
  if (running.has(job.id)) {
    log.warn(`Job ${job.id} is already running, skipping`);
    return;
  }

  // Quiet hours check
  if (isQuietHour(job)) {
    log.info(`Job ${job.id} skipped (quiet hours)`);
    return;
  }

  running.add(job.id);
  const startTime = Date.now();
  log.info(`Job ${job.id} started`);

  const maxRetries = job.maxRetries || 0;
  let lastError = null;
  let output = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        log.info(`Job ${job.id} retry ${attempt}/${maxRetries}`);
      }

      if (job.type === 'shell') {
        output = await runShell(job);
      } else if (job.type === 'ai' || job.type === 'claude') {
        output = await runAI(job);
      } else {
        throw new Error(`Unknown job type: ${job.type}`);
      }

      lastError = null;
      break; // success
    } catch (err) {
      lastError = err;
      log.error(`Job ${job.id} attempt ${attempt} failed:`, err.message);
    }
  }

  const elapsed = Date.now() - startTime;
  running.delete(job.id);

  if (lastError) {
    log.error(`Job ${job.id} failed after ${elapsed}ms: ${lastError.message}`);
  } else {
    log.info(`Job ${job.id} completed in ${elapsed}ms`);
  }

  // Notifications
  if (shouldNotify(job, output, lastError)) {
    try {
      await sendNotification(job, output, lastError ? lastError.message : null);
    } catch (notifyErr) {
      log.error(`Notification error for ${job.id}:`, notifyErr.message);
    }
  }
}

/**
 * Run a user-level job within its workspace.
 */
async function runUserJob(job, wsId, wsAbsPath) {
  const runKey = `${wsId}:${job.id}`;

  if (running.has(runKey)) {
    log.warn(`User job ${runKey} is already running, skipping`);
    return;
  }

  if (isQuietHour(job)) {
    log.info(`User job ${runKey} skipped (quiet hours)`);
    return;
  }

  running.add(runKey);
  const startTime = Date.now();
  log.info(`User job ${runKey} started`);

  let lastError = null;
  let output = null;

  try {
    // Support both new flat format (job.prompt) and legacy nested format (job.claude.prompt)
    const rawPrompt = job.prompt || (job.claude && job.claude.prompt);
    if (!rawPrompt) throw new Error(`User job ${job.id} has no prompt`);

    let prompt = templateReplace(rawPrompt, job);

    // Check for pending .new files that need AI self-merge
    const dotNewFiles = [];
    for (const base of ['SOUL.md', 'CLAUDE.md']) {
      if (fs.existsSync(join(wsAbsPath, `${base}.new`))) {
        dotNewFiles.push(base);
      }
    }
    if (dotNewFiles.length > 0) {
      const mergeInstructions = dotNewFiles.map(f =>
        `- Read \`${f}.new\`, integrate its new structure into \`${f}\` (preserve your evolved content). Remove any "⚠️ 系統升級通知" banner from \`${f}\` if present. Do NOT try to delete \`${f}.new\` — the system will clean it up automatically.`
      ).join('\n');
      prompt = `## Urgent: pending system upgrade files\nBefore doing anything else, handle these:\n${mergeInstructions}\n\n${prompt}`;
      log.info(`User job ${runKey}: injecting .new merge instructions for: ${dotNewFiles.join(', ')}`);
    }

    // System decides model and timeout based on tier
    const TIERS = {
      quick:    { model: 'claude-haiku-4-5-20251001', timeout: 60000 },
      standard: { model: 'claude-sonnet-4-6',         timeout: 180000 },
      deep:     { model: 'claude-opus-4-6',            timeout: 600000 },
    };
    const tier = TIERS[job.tier] || TIERS.standard;
    const model = tier.model;
    const timeout = tier.timeout;

    const syncPrompt = wm.readSyncPrompt();
    const systemParts = [...SCHEDULER_RULES, ...BASE_RULES];
    if (_sharedSoul) systemParts.push(_sharedSoul);
    if (syncPrompt) systemParts.push(syncPrompt);

    // Fixed whitelist — user has no control over tools
    const USER_JOB_ALLOWED_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Agent', 'WebSearch', 'WebFetch', 'TodoWrite'];

    // Merge system + per-workspace MCP config
    const mcp = buildMcpConfig(wsAbsPath);
    const allAllowedTools = [...USER_JOB_ALLOWED_TOOLS, ...mcp.toolPatterns];

    const provider = registry.get();
    log.info(`AI spawn for user job ${runKey}: provider=${provider.name} model=${model}, timeout=${timeout}ms, mcp=${mcp.toolPatterns.join(',') || 'none'}`);

    const result = await provider.run({
      prompt,
      model,
      allowedTools: allAllowedTools,
      disallowedTools: ['Bash'],
      systemPrompt: systemParts.join(' '),
      cwd: wsAbsPath,
      sandbox: true,
      timeout,
      mcpConfigPath: mcp.configPath,
    });

    output = result.text || 'Job completed (no text output)';

    // Clean up .new files after successful AI merge
    for (const base of dotNewFiles) {
      const newPath = join(wsAbsPath, `${base}.new`);
      try {
        fs.unlinkSync(newPath);
        log.info(`User job ${runKey}: cleaned up ${base}.new`);
      } catch (unlinkErr) {
        log.warn(`User job ${runKey}: failed to delete ${base}.new: ${unlinkErr.message}`);
      }
    }
  } catch (err) {
    lastError = err;
    log.error(`User job ${runKey} failed: ${err.message}`);
  }

  const elapsed = Date.now() - startTime;
  running.delete(runKey);

  // Collect outbox files (even on error — job may have produced partial output)
  const outboxFiles = collectOutbox(wsAbsPath);
  if (outboxFiles.length) {
    log.info(`User job ${runKey} outbox: ${outboxFiles.length} file(s)`);
  }

  log.info(`User job ${runKey} completed in ${elapsed}ms`);

  // Notify all bindings for this workspace
  if (shouldNotify(job, output, lastError)) {
    try {
      await notifyAllBindings(wsAbsPath, job, output, lastError ? lastError.message : null, outboxFiles);
    } catch (notifyErr) {
      log.error(`Notification error for user job ${runKey}:`, notifyErr.message);
    }
  }

  // Append to talk-history so proactive DMs are visible to event triggers
  if (output && !lastError) {
    wm.appendTalkHistory(wsAbsPath, `[job:${job.id}]`, output);
  }
}

function getRunningJobs() {
  return [...running];
}

module.exports = { runJob, runUserJob, isRunning, getRunningJobs };
