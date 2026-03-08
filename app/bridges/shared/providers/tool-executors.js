/**
 * Client-side tool executors for claude-api provider.
 *
 * Each executor: (input, context) => Promise<string>
 * Context: { cwd, log, abortSignal, depth }
 */
const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

const MAX_OUTPUT = 100 * 1024; // 100KB per tool result
const MAX_READ_LINES = 2000;
const WEBFETCH_TIMEOUT = 30000;
const WEBFETCH_MAX_SIZE = 1024 * 1024; // 1MB
const AGENT_MAX_DEPTH = 3;

// --- Path validation ---

function validatePath(inputPath, cwd) {
  const resolved = path.resolve(cwd, inputPath);
  const normalCwd = path.resolve(cwd);
  if (resolved !== normalCwd && !resolved.startsWith(normalCwd + path.sep)) {
    throw new Error(`Path "${inputPath}" resolves outside workspace`);
  }
  return resolved;
}

function truncate(str, max = MAX_OUTPUT) {
  if (str.length <= max) return str;
  return str.slice(0, max) + `\n...[truncated at ${max} bytes]`;
}

// --- Tool implementations ---

async function execRead(input, ctx) {
  const filePath = validatePath(input.file_path, ctx.cwd);

  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${input.file_path}`);
  }

  const stat = fs.statSync(filePath);
  if (stat.isDirectory()) {
    throw new Error(`"${input.file_path}" is a directory, not a file`);
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const allLines = content.split('\n');

  const offset = Math.max(0, (input.offset || 1) - 1);
  const limit = input.limit || MAX_READ_LINES;
  const lines = allLines.slice(offset, offset + limit);

  const numbered = lines.map((line, i) => {
    const lineNum = offset + i + 1;
    return `${String(lineNum).padStart(6)}\t${line}`;
  });

  let result = numbered.join('\n');
  if (offset + limit < allLines.length) {
    result += `\n\n[...${allLines.length - offset - limit} more lines]`;
  }

  return truncate(result);
}

async function execWrite(input, ctx) {
  const filePath = validatePath(input.file_path, ctx.cwd);
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, input.content, 'utf-8');
  return `File written: ${input.file_path} (${Buffer.byteLength(input.content)} bytes)`;
}

async function execEdit(input, ctx) {
  const filePath = validatePath(input.file_path, ctx.cwd);

  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${input.file_path}`);
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const { old_string, new_string, replace_all } = input;

  if (old_string === new_string) {
    throw new Error('old_string and new_string are identical');
  }

  if (replace_all) {
    if (!content.includes(old_string)) {
      throw new Error('old_string not found in file');
    }
    const updated = content.split(old_string).join(new_string);
    fs.writeFileSync(filePath, updated, 'utf-8');
    const count = (content.split(old_string).length - 1);
    return `Replaced ${count} occurrence(s) in ${input.file_path}`;
  }

  const firstIdx = content.indexOf(old_string);
  if (firstIdx === -1) {
    throw new Error('old_string not found in file');
  }

  const secondIdx = content.indexOf(old_string, firstIdx + old_string.length);
  if (secondIdx !== -1) {
    throw new Error('old_string is not unique in file — provide more context to make it unique');
  }

  const updated = content.slice(0, firstIdx) + new_string + content.slice(firstIdx + old_string.length);
  fs.writeFileSync(filePath, updated, 'utf-8');
  return `Edited ${input.file_path}`;
}

async function execGlob(input, ctx) {
  const searchDir = input.path ? validatePath(input.path, ctx.cwd) : ctx.cwd;
  const pattern = input.pattern;

  // Use simple recursive scan with minimatch-style matching
  const matches = [];
  const maxResults = 500;

  function matchGlob(filePath, pat) {
    // Convert glob to regex
    const regex = new RegExp(
      '^' +
      pat
        .replace(/\./g, '\\.')
        .replace(/\*\*/g, '{{GLOBSTAR}}')
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '[^/]')
        .replace(/\{\{GLOBSTAR\}\}/g, '.*')
      + '$'
    );
    return regex.test(filePath);
  }

  function scan(dir, relBase) {
    if (matches.length >= maxResults) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (matches.length >= maxResults) break;
      if (entry.name.startsWith('.') && !pattern.startsWith('.')) continue;
      const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        scan(path.join(dir, entry.name), rel);
      } else if (entry.isFile()) {
        if (matchGlob(rel, pattern)) {
          matches.push(rel);
        }
      }
    }
  }

  scan(searchDir, '');

  if (matches.length === 0) return 'No files matched.';
  let result = matches.join('\n');
  if (matches.length >= maxResults) {
    result += `\n\n[...capped at ${maxResults} results]`;
  }
  return truncate(result);
}

async function execGrep(input, ctx) {
  const searchPath = input.path ? validatePath(input.path, ctx.cwd) : ctx.cwd;
  const mode = input.output_mode || 'files_with_matches';

  // Try ripgrep first, fall back to node implementation
  try {
    const rgArgs = [input.pattern];

    if (mode === 'files_with_matches') rgArgs.push('-l');
    else if (mode === 'count') rgArgs.push('-c');
    else rgArgs.push('-n'); // content mode

    if (input.glob) rgArgs.push('--glob', input.glob);

    rgArgs.push('--max-count', '100');
    rgArgs.push('--max-filesize', '1M');
    rgArgs.push(searchPath);

    const result = execSync(`rg ${rgArgs.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ')}`, {
      encoding: 'utf-8',
      timeout: 30000,
      maxBuffer: MAX_OUTPUT,
      cwd: ctx.cwd,
    });

    return truncate(result.trim() || 'No matches found.');
  } catch (err) {
    // rg returns exit code 1 for "no matches"
    if (err.status === 1) return 'No matches found.';

    // Fallback: simple recursive search
    return fallbackGrep(input.pattern, searchPath, mode, input.glob);
  }
}

function fallbackGrep(pattern, searchPath, mode, globFilter) {
  const regex = new RegExp(pattern, 'g');
  const results = [];
  const maxResults = 100;

  function scan(dir) {
    if (results.length >= maxResults) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= maxResults) break;
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scan(full);
      } else if (entry.isFile()) {
        try {
          const content = fs.readFileSync(full, 'utf-8');
          const lines = content.split('\n');
          const matches = [];
          for (let i = 0; i < lines.length; i++) {
            if (regex.test(lines[i])) {
              matches.push({ line: i + 1, text: lines[i] });
              regex.lastIndex = 0;
            }
          }
          if (matches.length > 0) {
            if (mode === 'files_with_matches') {
              results.push(full);
            } else if (mode === 'count') {
              results.push(`${full}:${matches.length}`);
            } else {
              for (const m of matches) {
                results.push(`${full}:${m.line}:${m.text}`);
              }
            }
          }
        } catch {
          // skip unreadable files
        }
      }
    }
  }

  const stat = fs.statSync(searchPath);
  if (stat.isFile()) {
    try {
      const content = fs.readFileSync(searchPath, 'utf-8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          results.push(`${searchPath}:${i + 1}:${lines[i]}`);
          regex.lastIndex = 0;
        }
      }
    } catch { /* skip */ }
  } else {
    scan(searchPath);
  }

  return truncate(results.join('\n') || 'No matches found.');
}

async function execWebFetch(input, ctx) {
  const { url } = input;
  if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) {
    throw new Error('Invalid URL: must start with http:// or https://');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WEBFETCH_TIMEOUT);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Synapsis/1.0' },
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }

    const contentType = res.headers.get('content-type') || '';

    // Stream with size limit
    const reader = res.body.getReader();
    const chunks = [];
    let totalSize = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalSize += value.length;
      if (totalSize > WEBFETCH_MAX_SIZE) {
        reader.cancel();
        chunks.push(value.slice(0, WEBFETCH_MAX_SIZE - (totalSize - value.length)));
        break;
      }
      chunks.push(value);
    }

    const buffer = Buffer.concat(chunks);
    const text = buffer.toString('utf-8');

    return truncate(text);
  } finally {
    clearTimeout(timeout);
  }
}

async function execAgent(input, ctx) {
  const depth = (ctx.depth || 0) + 1;
  if (depth > AGENT_MAX_DEPTH) {
    throw new Error(`Agent recursion depth exceeded (max ${AGENT_MAX_DEPTH})`);
  }

  if (!ctx.runProvider) {
    throw new Error('Agent tool requires runProvider in context');
  }

  const result = await ctx.runProvider({
    prompt: input.prompt,
    systemPrompt: ctx.systemPrompt,
    cwd: ctx.cwd,
    depth,
  });

  return truncate(result.text || '(no output from sub-agent)');
}

async function execTodoWrite(input, ctx) {
  const filePath = path.join(ctx.cwd, 'TODO.md');
  const lines = ['# TODO', ''];

  for (const item of (input.todos || [])) {
    const checkbox = item.done ? '[x]' : '[ ]';
    lines.push(`- ${checkbox} ${item.task || ''}`);
  }

  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8');
  return `TODO.md updated (${input.todos?.length || 0} items)`;
}

async function execBash(input, ctx) {
  const { command } = input;
  const timeout = input.timeout || 60000;

  return new Promise((resolve, reject) => {
    const child = spawn('bash', ['-c', command], {
      cwd: ctx.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 5000);
      reject(new Error(`Bash timeout after ${timeout}ms`));
    }, timeout);

    child.on('close', (code) => {
      clearTimeout(timer);
      const output = stdout + (stderr ? `\nSTDERR:\n${stderr}` : '');
      if (code !== 0) {
        resolve(truncate(`Exit code ${code}\n${output}`));
      } else {
        resolve(truncate(output.trim() || '(no output)'));
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// --- Executor registry ---

const EXECUTORS = {
  Read: execRead,
  Write: execWrite,
  Edit: execEdit,
  Glob: execGlob,
  Grep: execGrep,
  WebFetch: execWebFetch,
  Agent: execAgent,
  TodoWrite: execTodoWrite,
  Bash: execBash,
};

/**
 * Execute a tool by name.
 *
 * @param {string} name - Tool name
 * @param {object} input - Tool input
 * @param {object} ctx - Context { cwd, log, depth, runProvider, systemPrompt }
 * @returns {Promise<string>}
 */
async function executeTool(name, input, ctx) {
  const executor = EXECUTORS[name];
  if (!executor) {
    throw new Error(`Unknown tool: ${name}`);
  }
  return executor(input, ctx);
}

module.exports = { executeTool, validatePath, EXECUTORS };
