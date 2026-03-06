const { spawn } = require('child_process');
const fs = require('fs');
const { resolve, join } = require('path');
const log = require('./logger');
const { shouldNotify, sendNotification, notifyAllBindings } = require('./notifier');
const registry = require('../../bridges/shared/providers/registry');
const { BASE_RULES } = require('../../bridges/shared/system-prompt');
const wm = require('../../bridges/shared/workspace-manager');
const { sanitizeOutput, isTextFile } = require('../../bridges/shared/sanitize');

const OUTBOX_DIR = 'outbox';
const MAX_OUTBOX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

const PROJECT_DIR = process.env.PROJECT_DIR || resolve(join(__dirname, '../..'));

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

function templateReplace(str, job) {
  let result = str.replace(/\{\{TIMESTAMP\}\}/g, new Date().toISOString());
  if (job && job._specContent) {
    result = result.replace(/\{\{SPEC\}\}/g, job._specContent);
  }
  if (job && job._talkHistory) {
    result = result.replace(/\{\{TALK_HISTORY\}\}/g, job._talkHistory);
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

  log.info(`AI spawn for job ${job.id}: provider=${provider.name} model=${config.model || 'default'}`);

  try {
    const result = await provider.run({
      prompt,
      model: config.model,
      allowedTools: config.allowedTools,
      maxBudgetUsd: config.maxBudgetUsd,
      systemPrompt: SYSTEM_PROMPT.join(' '),
      cwd: PROJECT_DIR,
      timeout,
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

    const prompt = templateReplace(rawPrompt, job);

    // System decides model and timeout based on tier
    const TIERS = {
      quick:    { model: 'claude-haiku-4-5-20251001', timeout: 60000 },
      standard: { model: 'claude-sonnet-4-6',         timeout: 120000 },
      deep:     { model: 'claude-opus-4-6',            timeout: 600000 },
    };
    const tier = TIERS[job.tier] || TIERS.standard;
    const model = tier.model;
    const timeout = tier.timeout;

    const syncPrompt = wm.readSyncPrompt();
    const systemParts = [...SCHEDULER_RULES, ...BASE_RULES];
    if (syncPrompt) systemParts.push(syncPrompt);

    // Fixed whitelist — user has no control over tools
    const USER_JOB_ALLOWED_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Agent', 'WebSearch', 'WebFetch', 'TodoWrite'];

    const provider = registry.get();
    log.info(`AI spawn for user job ${runKey}: provider=${provider.name} model=${model}, timeout=${timeout}ms`);

    const result = await provider.run({
      prompt,
      model,
      allowedTools: USER_JOB_ALLOWED_TOOLS,
      disallowedTools: ['Bash'],
      systemPrompt: systemParts.join(' '),
      cwd: wsAbsPath,
      sandbox: true,
      timeout,
    });

    output = result.text || 'Job completed (no text output)';
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
}

function getRunningJobs() {
  return [...running];
}

module.exports = { runJob, runUserJob, isRunning, getRunningJobs };
