/**
 * Tool name → Anthropic API tool schema mapping.
 *
 * Separates server-side tools (executed by Anthropic) from
 * client-side tools (executed locally by tool-executors.js).
 */

// --- Server-side tools (Anthropic executes these) ---

const SERVER_TOOLS = {
  WebSearch: { type: 'web_search_20250305' },
};

// --- Client-side tool schemas ---

const CLIENT_TOOL_SCHEMAS = {
  Read: {
    name: 'Read',
    description: 'Read a file from the workspace. Returns contents with line numbers.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Relative or absolute path to the file' },
        offset: { type: 'number', description: 'Line number to start reading from (1-based)' },
        limit: { type: 'number', description: 'Number of lines to read' },
      },
      required: ['file_path'],
    },
  },

  Write: {
    name: 'Write',
    description: 'Write content to a file in the workspace. Creates parent directories if needed.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Relative or absolute path to the file' },
        content: { type: 'string', description: 'The content to write' },
      },
      required: ['file_path', 'content'],
    },
  },

  Edit: {
    name: 'Edit',
    description: 'Replace a string in a file. old_string must be unique in the file.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Relative or absolute path to the file' },
        old_string: { type: 'string', description: 'The exact text to find and replace' },
        new_string: { type: 'string', description: 'The replacement text' },
        replace_all: { type: 'boolean', description: 'Replace all occurrences (default false)' },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
  },

  Glob: {
    name: 'Glob',
    description: 'Find files matching a glob pattern (e.g. "**/*.js").',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern to match files' },
        path: { type: 'string', description: 'Directory to search in (default: workspace root)' },
      },
      required: ['pattern'],
    },
  },

  Grep: {
    name: 'Grep',
    description: 'Search file contents using regex. Returns matching file paths or lines.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex pattern to search for' },
        path: { type: 'string', description: 'File or directory to search in' },
        glob: { type: 'string', description: 'Glob to filter files (e.g. "*.js")' },
        output_mode: {
          type: 'string',
          enum: ['files_with_matches', 'content', 'count'],
          description: 'Output mode (default: files_with_matches)',
        },
      },
      required: ['pattern'],
    },
  },

  WebFetch: {
    name: 'WebFetch',
    description: 'Fetch content from a URL and return the text.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to fetch' },
      },
      required: ['url'],
    },
  },

  Agent: {
    name: 'Agent',
    description: 'Launch a sub-agent to handle a complex task autonomously.',
    input_schema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The task for the sub-agent to perform' },
        description: { type: 'string', description: 'Short description of the task (3-5 words)' },
      },
      required: ['prompt'],
    },
  },

  TodoWrite: {
    name: 'TodoWrite',
    description: 'Write a TODO list to the workspace TODO.md file.',
    input_schema: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              task: { type: 'string' },
              done: { type: 'boolean' },
            },
          },
          description: 'Array of todo items',
        },
      },
      required: ['todos'],
    },
  },

  Bash: {
    name: 'Bash',
    description: 'Execute a bash command.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command to execute' },
        description: { type: 'string', description: 'Description of what this command does' },
        timeout: { type: 'number', description: 'Timeout in milliseconds' },
      },
      required: ['command'],
    },
  },
};

/**
 * Build tool definitions for the Anthropic API.
 *
 * @param {string[]} [allowedTools] - Tool names to include
 * @param {string[]} [disallowedTools] - Tool names to exclude
 * @returns {{ tools: object[] }} - tools array for API params
 */
function buildToolDefinitions(allowedTools, disallowedTools) {
  const allowed = new Set(allowedTools || Object.keys(CLIENT_TOOL_SCHEMAS));
  const disallowed = new Set(disallowedTools || []);

  const tools = [];

  for (const name of allowed) {
    if (disallowed.has(name)) continue;

    // Server-side tools have a special format
    if (SERVER_TOOLS[name]) {
      tools.push(SERVER_TOOLS[name]);
      continue;
    }

    // Client-side tools use standard tool format
    if (CLIENT_TOOL_SCHEMAS[name]) {
      tools.push(CLIENT_TOOL_SCHEMAS[name]);
    }
  }

  return { tools };
}

/**
 * Check if a tool name is a server-side tool (executed by Anthropic).
 */
function isServerTool(name) {
  return !!SERVER_TOOLS[name];
}

module.exports = { buildToolDefinitions, isServerTool, CLIENT_TOOL_SCHEMAS, SERVER_TOOLS };
