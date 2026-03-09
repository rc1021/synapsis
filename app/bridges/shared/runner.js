/**
 * Shared runner — channel-agnostic AI execution with:
 *   - Per-workspace serialized concurrency queue
 *   - Global concurrency gate
 *   - Idle + hard-cap timeout management
 *   - Security monitoring on tool events
 *   - Progress reporting via callback
 *
 * Used by all bridges (Discord, Telegram, WhatsApp, etc.)
 */
const fs = require('fs');
const path = require('path');
const { createLogger } = require('./logger');
const log = createLogger('runner', {
  logDir: process.env.LOG_DIR || path.join(__dirname, '..', '..', 'logs'),
});
const { BASE_RULES } = require('./system-prompt');
const wm = require('./workspace-manager');
const securityMonitor = require('./security-monitor');
const registry = require('./providers/registry');

const SHARED_SOUL_PATH = path.join(__dirname, '..', '..', 'SOUL.md');
let _sharedSoul = '';
try {
  _sharedSoul = fs.readFileSync(SHARED_SOUL_PATH, 'utf-8');
} catch (err) {
  log.warn(`Failed to load shared SOUL.md: ${err.message}`);
}

const MAX_CONCURRENCY = parseInt(process.env.MAX_CONCURRENCY || '3', 10);
const CLAUDE_IDLE_TIMEOUT = parseInt(process.env.CLAUDE_IDLE_TIMEOUT || '300000', 10);
const CLAUDE_MAX_TIMEOUT = parseInt(process.env.CLAUDE_MAX_TIMEOUT || '900000', 10);
const CLAUDE_MAX_EXTENSIONS = parseInt(process.env.CLAUDE_MAX_EXTENSIONS || '5', 10);
const ALLOWED_TOOLS = (process.env.ALLOWED_TOOLS || 'Read,Write,Edit,Glob,Grep,Agent,WebSearch,WebFetch,TodoWrite').split(',');

// Per-workspace queues: same workspace serializes, different workspaces run in parallel
let running = 0;
const workspaceQueues = new Map();

function processQueue(wsPath) {
  const wq = workspaceQueues.get(wsPath);
  if (!wq || wq.running || wq.queue.length === 0) return;
  if (running >= MAX_CONCURRENCY) return;

  const next = wq.queue.shift();
  wq.running = true;
  running++;

  executeJob(next).finally(() => {
    running--;
    wq.running = false;
    if (wq.queue.length === 0) {
      workspaceQueues.delete(wsPath);
    }
    processQueue(wsPath);
    for (const key of workspaceQueues.keys()) {
      if (key !== wsPath) processQueue(key);
    }
  });
}

/**
 * Enqueue a prompt for execution.
 *
 * @param {object} opts
 * @param {string} opts.prompt
 * @param {string} opts.sessionId
 * @param {boolean} [opts.isResume=false]
 * @param {function} [opts.onProgress] - Channel-specific progress callback
 * @param {string} opts.cwd - Workspace path
 * @param {string[]} [opts.channelRules] - Channel-specific system prompt rules
 * @param {boolean} [opts.verbose=false] - Add --verbose flag (CLI provider)
 * @returns {Promise<RunnerResult>}
 */
function enqueue(opts) {
  const { cwd } = opts;
  return new Promise((resolve, reject) => {
    if (!workspaceQueues.has(cwd)) {
      workspaceQueues.set(cwd, { running: false, queue: [] });
    }
    workspaceQueues.get(cwd).queue.push({ ...opts, resolve, reject });
    processQueue(cwd);
  });
}

async function executeJob(job) {
  try {
    const result = await runWithProvider(job);
    // Clean up .new files after successful AI execution
    if (job.cwd) {
      for (const base of ['SOUL.md', 'CLAUDE.md']) {
        const newPath = path.join(job.cwd, `${base}.new`);
        if (fs.existsSync(newPath)) {
          try {
            fs.unlinkSync(newPath);
            log.info(`Cleaned up ${base}.new in ${job.cwd}`);
          } catch (unlinkErr) {
            log.warn(`Failed to delete ${base}.new: ${unlinkErr.message}`);
          }
        }
      }
    }
    job.resolve(result);
  } catch (err) {
    job.reject(err);
  }
}

/**
 * Build system prompt from channel rules + base rules + sync prompt.
 */
function buildSystemPrompt(channelRules, isResume) {
  const parts = [...(channelRules || []), ...BASE_RULES];

  if (_sharedSoul) {
    parts.push(_sharedSoul);
  }

  const syncPrompt = wm.readSyncPrompt();
  if (syncPrompt) {
    parts.push(syncPrompt);
  }

  if (!isResume) {
    parts.unshift('Before responding, read CLAUDE.md and follow its instructions.');
  }

  return parts.join(' ');
}

/**
 * Extract tool description for progress display.
 */
function extractToolDescription(name, input) {
  const basename = (p) => p ? p.split('/').pop() : '';
  switch (name) {
    case 'Read': return basename(input.file_path) || name;
    case 'Edit': return basename(input.file_path) || name;
    case 'Write': return basename(input.file_path) || name;
    case 'Grep': return input.pattern ? `/${input.pattern}/` : name;
    case 'Glob': return input.pattern || name;
    case 'Bash': return input.description || input.command?.slice(0, 50) || name;
    case 'Agent': return input.description || input.prompt?.slice(0, 50) || name;
    default: return input.description || input.prompt?.slice(0, 50) || name;
  }
}

/**
 * Run a prompt through the configured provider with streaming.
 */
function runWithProvider({
  prompt,
  sessionId,
  isResume = false,
  onProgress,
  cwd,
  channelRules,
  verbose = false,
  resolve: _resolve,
  reject: _reject,
}) {
  return new Promise((resolve, reject) => {
    const provider = registry.get();
    const systemPrompt = buildSystemPrompt(channelRules, isResume);

    const streamOpts = {
      prompt,
      sessionId,
      resume: isResume,
      outputFormat: 'stream-json',
      allowedTools: ALLOWED_TOOLS,
      disallowedTools: ['Bash'],
      systemPrompt,
      cwd,
      sandbox: true,
      verbose,
    };

    log.info(`Runner spawn: provider=${provider.name} resume=${isResume} session=${sessionId} cwd=${cwd}`);

    const stream = provider.runStream(streamOpts);

    let timedOut = false;
    let inputTokens = 0;
    let outputTokens = 0;
    const textBlocks = [];
    let usedAgentTool = false;
    let eventCount = 0;

    // Agent token tracking
    let phase = 'main';
    let agentPending = false;
    let mainContextBaseline = 0;
    let agentInputTokens = 0;
    let agentOutputTokens = 0;

    // Tool tracking
    const notifiedToolIds = new Set();

    // --- Idle timeout ---
    let idleTimer = null;
    let activeIdleTimeout = CLAUDE_IDLE_TIMEOUT;
    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        timedOut = true;
        log.warn(`Runner idle timeout (${activeIdleTimeout}ms, ${eventCount} events), killing`);
        stream.kill();
      }, activeIdleTimeout);
    };
    resetIdleTimer();

    // --- Hard cap timeout ---
    let hardTimer = null;
    let extensionCount = 0;
    const spawnTime = Date.now();

    function killStream(reason) {
      timedOut = true;
      log.warn(`Runner ${reason}, killing`);
      stream.kill();
    }

    function scheduleHardTimeout() {
      if (hardTimer) clearTimeout(hardTimer);
      hardTimer = setTimeout(async () => {
        const elapsed = Math.round((Date.now() - spawnTime) / 60000);

        if (!onProgress || extensionCount >= CLAUDE_MAX_EXTENSIONS) {
          killStream(`hard timeout (${elapsed}min, extensions=${extensionCount}/${CLAUDE_MAX_EXTENSIONS})`);
          return;
        }

        log.info(`Hard timeout reached (${elapsed}min), asking user to continue or kill`);
        try {
          const shouldContinue = await onProgress({
            type: 'timeout_confirm',
            elapsed,
            eventCount,
            extensionCount,
            maxExtensions: CLAUDE_MAX_EXTENSIONS,
          });

          if (shouldContinue) {
            extensionCount++;
            log.info(`User chose to continue (extension ${extensionCount}/${CLAUDE_MAX_EXTENSIONS})`);
            scheduleHardTimeout();
          } else {
            killStream(`user chose to stop after ${elapsed}min`);
          }
        } catch (err) {
          log.warn(`Timeout confirm error: ${err.message}, killing`);
          killStream(`timeout confirm failed after ${elapsed}min`);
        }
      }, CLAUDE_MAX_TIMEOUT);
    }
    scheduleHardTimeout();

    function emitToolProgress(name, description, toolId) {
      if (!onProgress) return;
      if (toolId && notifiedToolIds.has(toolId)) return;
      if (toolId) notifiedToolIds.add(toolId);
      log.info(`Tool progress: ${name} — ${description}`);
      onProgress({ type: 'tool_start', name, description });
    }

    // --- Listen to provider stream events ---

    stream.on('event', () => {
      eventCount++;
      resetIdleTimer();
    });

    stream.on('text_delta', (e) => {
      textBlocks.push(e.text);
    });

    stream.on('usage', (e) => {
      if (e.inputTokens) {
        // Agent phase tracking
        if (phase === 'agent') {
          if (e.inputTokens > mainContextBaseline) {
            phase = 'main';
            activeIdleTimeout = CLAUDE_IDLE_TIMEOUT;
            resetIdleTimer();
            log.info('Agent done, idle timeout restored to normal');
          } else {
            agentInputTokens += e.inputTokens;
          }
        }
        inputTokens = e.inputTokens;
      }
      if (e.outputTokens) {
        outputTokens = e.outputTokens;
        if (phase === 'agent') {
          agentOutputTokens += e.outputTokens;
        }
        if (agentPending) {
          mainContextBaseline = inputTokens;
          phase = 'agent';
          agentPending = false;
        }
      }
    });

    stream.on('tool_start', (e) => {
      if (/agent/i.test(e.name)) {
        usedAgentTool = true;
        agentPending = true;
      }
      const desc = extractToolDescription(e.name, e.input || {});
      emitToolProgress(e.name, desc, e.id);
    });

    stream.on('tool_end', (e) => {
      // Security: check tool call for workspace escape attempts
      if (e.name && e.input && cwd) {
        const result = securityMonitor.checkToolCall(e.name, e.input, cwd);
        if (result && result.violation) {
          securityMonitor.recordViolation(cwd, e.name, result.reason);
          if (securityMonitor.shouldKillSession(cwd)) {
            log.warn(`[SECURITY] 6+ violations for ${cwd}, killing session`);
            stream.kill();
          }
        }
      }
    });

    stream.on('result', (e) => {
      if (idleTimer) clearTimeout(idleTimer);
      if (hardTimer) clearTimeout(hardTimer);

      if (onProgress) {
        onProgress({ type: 'done', agentInputTokens, agentOutputTokens });
      }

      const text = e.text || textBlocks.join('').trim();
      const finalInput = e.inputTokens || inputTokens;
      const finalOutput = e.outputTokens || outputTokens;

      log.info(`Runner response: ${text.length} chars, tokens: ${finalInput}in/${finalOutput}out, agent=${usedAgentTool}(${agentInputTokens}in/${agentOutputTokens}out), events=${eventCount}`);

      resolve({
        text,
        inputTokens: finalInput,
        outputTokens: finalOutput,
        totalTokens: finalInput + finalOutput,
        usedAgentTool,
        agentInputTokens,
        agentOutputTokens,
      });
    });

    stream.on('error', (e) => {
      if (idleTimer) clearTimeout(idleTimer);
      if (hardTimer) clearTimeout(hardTimer);

      const err = new Error(e.message || 'Provider error');
      err.timedOut = timedOut;
      log.error(`Runner error: ${err.message}`);
      reject(err);
    });

    // Fallback: if close fires without result or error
    let settled = false;
    const origResolve = resolve;
    const origReject = reject;
    resolve = (v) => { settled = true; origResolve(v); };
    reject = (e) => { settled = true; origReject(e); };

    stream.on('close', () => {
      if (idleTimer) clearTimeout(idleTimer);
      if (hardTimer) clearTimeout(hardTimer);
      if (!settled) {
        const text = textBlocks.join('').trim();
        origResolve({
          text,
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
          usedAgentTool,
          agentInputTokens,
          agentOutputTokens,
        });
      }
    });
  });
}

module.exports = { enqueue };

/**
 * @typedef {object} RunnerResult
 * @property {string} text
 * @property {number} inputTokens
 * @property {number} outputTokens
 * @property {number} totalTokens
 * @property {boolean} usedAgentTool
 * @property {number} agentInputTokens
 * @property {number} agentOutputTokens
 */
