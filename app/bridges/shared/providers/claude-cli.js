const { spawn, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { BaseProvider, StreamHandle } = require('./base');

const CLAUDE_PATH = process.env.CLAUDE_PATH || execSync('which claude', { encoding: 'utf-8' }).trim();
const IS_MACOS = os.platform() === 'darwin';
const IS_LINUX = os.platform() === 'linux';
const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

// Detect firejail on Linux (once at startup)
let FIREJAIL_PATH = null;
if (IS_LINUX) {
  try {
    FIREJAIL_PATH = execSync('which firejail', { encoding: 'utf-8' }).trim();
  } catch {
    console.warn('[SECURITY] firejail not found. Running without OS-level sandbox.');
  }
}

// Project root directory
const PROJECT_DIR = path.resolve(path.join(__dirname, '..', '..', '..', '..'));

/**
 * Strip CLAUDE_CODE / CLAUDECODE / CLAUDE_MCP env vars.
 */
function cleanEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('CLAUDECODE') || key.startsWith('CLAUDE_CODE')) {
      delete env[key];
    }
  }
  delete env.CLAUDE_MCP;
  return env;
}

/**
 * macOS sandbox-exec profile.
 */
function buildSandboxProfile(workspacePath) {
  const home = os.homedir();
  const esc = (p) => p.replace(/"/g, '\\"');

  return `(version 1)
(deny default)

;; Allow process, IPC, network, system operations
(allow process*)
(allow sysctl-read)
(allow mach*)
(allow ipc*)
(allow signal)
(allow network*)
(allow system*)

;; Allow all file reads by default (system libs, node, claude binary, etc.)
(allow file-read*)

;; DENY reads to project directory (blocks CLAUDE.md, .env, source code, other workspaces)
(deny file-read* (subpath "${esc(PROJECT_DIR)}"))

;; Allow metadata (lstat/stat) on project dir — needed for path resolution
(allow file-read-metadata (subpath "${esc(PROJECT_DIR)}"))

;; Re-allow reads for THIS workspace only
(allow file-read* (subpath "${esc(workspacePath)}"))

;; WRITE: only this workspace + system temp + Claude config
(allow file-write* (subpath "${esc(workspacePath)}"))
(allow file-write* (subpath "/private/tmp"))
(allow file-write* (subpath "/private/var/folders"))
(allow file-write* (subpath "${esc(home)}/.claude"))
`;
}

/**
 * Linux firejail args.
 */
function buildFirejailArgs(workspacePath) {
  const home = os.homedir();
  const appDir = path.join(PROJECT_DIR, 'app');

  const blacklist = [
    path.join(PROJECT_DIR, 'CLAUDE.md'),
    path.join(PROJECT_DIR, '.env'),
    path.join(appDir, '.env'),
    path.join(appDir, 'src'),
    path.join(appDir, 'bridges'),
    path.join(appDir, 'scheduler'),
    path.join(appDir, 'scripts'),
    path.join(appDir, 'channels'),
    path.join(appDir, 'tools'),
    path.join(appDir, 'workspace'),
    path.join(appDir, 'workspace-template'),
    path.join(appDir, 'node_modules'),
    path.join(appDir, 'workspaces', 'index'),
    path.join(appDir, 'workspaces', 'invites'),
    path.join(appDir, 'workspaces', 'bind-tokens'),
  ];

  return [
    '--noprofile',
    ...blacklist.filter(p => fs.existsSync(p)).map(p => `--blacklist=${p}`),
    `--read-write=${workspacePath}`,
    `--read-write=${home}/.claude`,
    '--read-write=/tmp',
    '--quiet',
    '--',
  ];
}

/**
 * Build Claude CLI arguments.
 */
function buildCliArgs({
  prompt,
  sessionId,
  resume = false,
  model,
  outputFormat = 'json',
  allowedTools,
  disallowedTools,
  maxBudgetUsd,
  systemPrompt,
  sandbox = false,
  verbose = false,
}) {
  const args = [
    '-p', prompt,
    '--output-format', outputFormat,
    '--dangerously-skip-permissions',
  ];

  if (sandbox) {
    args.push('--setting-sources', 'local');
  }

  if (allowedTools && allowedTools.length > 0) {
    args.push('--allowedTools', ...allowedTools);
  }

  if (disallowedTools && disallowedTools.length > 0) {
    args.push('--disallowedTools', ...disallowedTools);
  }

  if (systemPrompt) {
    args.push('--append-system-prompt', systemPrompt);
  }

  if (model) {
    args.push('--model', model);
  }

  if (maxBudgetUsd) {
    args.push('--max-budget-usd', String(maxBudgetUsd));
  }

  if (resume && sessionId) {
    args.push('--resume', sessionId);
  } else if (sessionId) {
    args.push('--session-id', sessionId);
  }

  if (verbose) {
    args.push('--verbose');
  }

  return args;
}

/**
 * Spawn a Claude CLI process with optional OS-level sandbox.
 */
function spawnProcess(args, cwd, sandbox) {
  const env = cleanEnv();
  let spawnCmd, spawnArgs;

  if (sandbox && IS_MACOS) {
    const profile = buildSandboxProfile(cwd);
    spawnCmd = SANDBOX_EXEC;
    spawnArgs = ['-p', profile, CLAUDE_PATH, ...args];
  } else if (sandbox && IS_LINUX && FIREJAIL_PATH) {
    const fjArgs = buildFirejailArgs(cwd);
    spawnCmd = FIREJAIL_PATH;
    spawnArgs = [...fjArgs, CLAUDE_PATH, ...args];
  } else {
    spawnCmd = CLAUDE_PATH;
    spawnArgs = args;
  }

  return spawn(spawnCmd, spawnArgs, {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * Parse a stream-json NDJSON event and emit standardized events on the handle.
 */
function processStreamEvent(raw, handle, state) {
  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return;
  }

  const type = event.type || event.event;

  switch (type) {
    case 'message_start':
      if (event.message?.usage?.input_tokens) {
        state.inputTokens = event.message.usage.input_tokens;
        handle.emit('usage', {
          inputTokens: state.inputTokens,
          outputTokens: state.outputTokens,
          phase: state.phase,
        });
      }
      break;

    case 'content_block_start':
      if (event.content_block?.type === 'tool_use') {
        state.currentToolName = event.content_block.name || '';
        state.currentToolInput = '';
        state.currentToolId = event.content_block.id || '';
      }
      state.currentText = '';
      break;

    case 'content_block_delta':
      if (event.delta?.type === 'text_delta' && event.delta.text) {
        state.currentText += event.delta.text;
        handle.emit('text_delta', { text: event.delta.text });
      }
      if (event.delta?.type === 'input_json_delta' && event.delta.partial_json) {
        state.currentToolInput += event.delta.partial_json;
      }
      break;

    case 'content_block_stop':
      if (state.currentText) {
        state.textBlocks.push(state.currentText);
        state.currentText = '';
      }
      if (state.currentToolName) {
        // Try to parse tool input for the event
        let parsedInput = {};
        try { parsedInput = JSON.parse(state.currentToolInput); } catch {}
        handle.emit('tool_end', {
          id: state.currentToolId,
          name: state.currentToolName,
          input: parsedInput,
        });
        state.currentToolName = '';
        state.currentToolInput = '';
        state.currentToolId = '';
      }
      break;

    case 'message_delta':
      if (event.usage?.output_tokens) {
        state.outputTokens = event.usage.output_tokens;
        handle.emit('usage', {
          inputTokens: state.inputTokens,
          outputTokens: state.outputTokens,
        });
      }
      break;

    case 'assistant':
      if (event.message?.content) {
        for (const block of event.message.content) {
          if (block.type === 'tool_use') {
            handle.emit('tool_start', {
              name: block.name || '',
              input: block.input || {},
              id: block.id || '',
            });
          }
        }
      }
      break;

    case 'result':
      if (event.result && !state.textBlocks.length && !state.currentText) {
        state.textBlocks.push(event.result);
      }
      if (event.usage) {
        const u = event.usage;
        state.inputTokens = (u.input_tokens || 0)
          + (u.cache_creation_input_tokens || 0)
          + (u.cache_read_input_tokens || 0);
        state.outputTokens = u.output_tokens || 0;
      } else {
        if (event.input_tokens) state.inputTokens = event.input_tokens;
        if (event.output_tokens) state.outputTokens = event.output_tokens;
      }
      break;
  }
}

class ClaudeCLIProvider extends BaseProvider {
  constructor() {
    super('claude-cli');
  }

  /**
   * Non-streaming run — uses JSON output format.
   */
  run(options) {
    const { cwd, sandbox = false, timeout } = options;

    const args = buildCliArgs({
      ...options,
      outputFormat: 'json',
    });

    return new Promise((resolve, reject) => {
      const child = spawnProcess(args, cwd || process.cwd(), sandbox);

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (d) => { stdout += d.toString(); });
      child.stderr.on('data', (d) => { stderr += d.toString(); });

      let timer;
      if (timeout) {
        timer = setTimeout(() => {
          child.kill('SIGTERM');
          setTimeout(() => child.kill('SIGKILL'), 5000);
          reject(new Error(`Claude CLI timeout after ${timeout}ms`));
        }, timeout);
      }

      child.on('close', (code) => {
        if (timer) clearTimeout(timer);
        if (code !== 0) {
          return reject(new Error(`Claude CLI exited with code ${code}: ${stderr.slice(0, 300)}`));
        }

        try {
          const parsed = JSON.parse(stdout);
          const text = parsed.result || parsed.text || '';
          const usage = parsed.usage || {};
          resolve({
            text: String(text),
            inputTokens: usage.input_tokens || 0,
            outputTokens: usage.output_tokens || 0,
            totalTokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
            raw: parsed,
          });
        } catch {
          resolve({
            text: stdout.trim(),
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
          });
        }
      });

      child.on('error', (err) => {
        if (timer) clearTimeout(timer);
        reject(err);
      });
    });
  }

  /**
   * Streaming run — uses stream-json output format.
   * Returns a StreamHandle that emits standardized events.
   */
  runStream(options) {
    const { cwd, sandbox = false } = options;
    const handle = new StreamHandle();

    const args = buildCliArgs({
      ...options,
      outputFormat: 'stream-json',
    });

    const child = spawnProcess(args, cwd || process.cwd(), sandbox);

    const state = {
      textBlocks: [],
      currentText: '',
      inputTokens: 0,
      outputTokens: 0,
      currentToolName: '',
      currentToolInput: '',
      currentToolId: '',
    };

    let lineBuffer = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      lineBuffer += chunk.toString();
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) {
          handle.emit('event', trimmed);
          processStreamEvent(trimmed, handle, state);
        }
      }
    });

    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    child.on('close', (code) => {
      if (lineBuffer.trim()) {
        handle.emit('event', lineBuffer.trim());
        processStreamEvent(lineBuffer.trim(), handle, state);
        lineBuffer = '';
      }

      if (code !== 0) {
        handle.emit('error', {
          message: `Claude CLI exited with code ${code}: ${stderr.slice(0, 300)}`,
          code,
        });
      }

      handle.emit('result', {
        text: state.textBlocks.join('').trim(),
        inputTokens: state.inputTokens,
        outputTokens: state.outputTokens,
      });

      handle.emit('close');
    });

    child.on('error', (err) => {
      handle.emit('error', { message: err.message });
      handle.emit('close');
    });

    // Override kill to terminate the child process
    handle.kill = () => {
      if (!handle._killed) {
        handle._killed = true;
        child.kill('SIGTERM');
        setTimeout(() => {
          try { child.kill('SIGKILL'); } catch {}
        }, 5000);
      }
    };

    // Expose child for callers that need low-level access
    handle.child = child;

    return handle;
  }
}

// Backward compat exports
module.exports = { ClaudeCLIProvider, cleanEnv, buildCliArgs, spawnProcess, CLAUDE_PATH };
