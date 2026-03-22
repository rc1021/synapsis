/**
 * MCP configuration merger — two-layer system:
 *   1. System-level: app/mcp-system.json (applies to all workspaces)
 *   2. Per-workspace: workspace/.mcp.json (user-selected servers)
 *
 * Merges both layers into a temp file for --mcp-config flag.
 * Per-workspace servers override system servers with the same name.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { createLogger } = require('./logger');
const log = createLogger('mcp-config', {
  logDir: process.env.LOG_DIR || path.join(__dirname, '..', '..', 'logs'),
});

const SYSTEM_MCP_PATH = path.join(__dirname, '..', '..', 'mcp-system.json');
const APP_DIR = path.join(__dirname, '..', '..');
const MERGED_DIR = path.join(os.tmpdir(), 'synapsis-mcp');

// Cache: wsPath → { mtime, configPath, toolPatterns }
const cache = new Map();

/**
 * Load MCP config from a JSON file. Returns { mcpServers: {} } on failure.
 */
function loadMcpFile(filePath) {
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return data && data.mcpServers ? data : { mcpServers: {} };
  } catch {
    return { mcpServers: {} };
  }
}

/**
 * Get modification time of a file, or 0 if not found.
 */
function getMtime(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Build merged MCP config for a workspace.
 *
 * @param {string} wsPath - Absolute workspace path (or null for system-only)
 * @returns {{ configPath: string, toolPatterns: string[] }}
 *   configPath: path to merged temp .mcp.json
 *   toolPatterns: list of MCP tool patterns for allowedTools (e.g. "mcp__puppeteer__*")
 */
function buildMcpConfig(wsPath) {
  const wsMcpPath = wsPath ? path.join(wsPath, '.mcp.json') : null;

  // Check cache freshness
  const cacheKey = wsPath || '__system__';
  const systemMtime = getMtime(SYSTEM_MCP_PATH);
  const wsMtime = wsMcpPath ? getMtime(wsMcpPath) : 0;
  const combinedMtime = systemMtime + wsMtime;

  const cached = cache.get(cacheKey);
  if (cached && cached.mtime === combinedMtime) {
    return { configPath: cached.configPath, toolPatterns: cached.toolPatterns };
  }

  // Load and merge
  const systemConfig = loadMcpFile(SYSTEM_MCP_PATH);
  const wsConfig = wsMcpPath ? loadMcpFile(wsMcpPath) : { mcpServers: {} };

  // System servers first, workspace servers override
  const merged = {
    mcpServers: {
      ...systemConfig.mcpServers,
      ...wsConfig.mcpServers,
    },
  };

  // Inject dynamic placeholders: __APP_DIR__ and __WORKSPACE_DIR__
  // Servers that require __WORKSPACE_DIR__ are dropped when no workspace is available.
  for (const [name, cfg] of Object.entries(merged.mcpServers)) {
    const cfgStr = JSON.stringify(cfg);
    if (cfgStr.includes('__WORKSPACE_DIR__') && !wsPath) {
      delete merged.mcpServers[name];
      continue;
    }
    if (cfgStr.includes('__APP_DIR__') || cfgStr.includes('__WORKSPACE_DIR__')) {
      const replaced = cfgStr
        .replace(/__APP_DIR__/g, APP_DIR.replace(/\\/g, '\\\\'))
        .replace(/__WORKSPACE_DIR__/g, (wsPath || '').replace(/\\/g, '\\\\'));
      merged.mcpServers[name] = JSON.parse(replaced);
    }
  }

  // Build tool patterns for allowedTools
  const toolPatterns = Object.keys(merged.mcpServers)
    .filter(name => merged.mcpServers[name] && merged.mcpServers[name].command)
    .map(name => `mcp__${name}__*`);

  // No MCP servers configured → return empty config
  if (toolPatterns.length === 0) {
    const emptyPath = path.join(MERGED_DIR, 'empty.json');
    ensureMergedDir();
    if (!fs.existsSync(emptyPath)) {
      fs.writeFileSync(emptyPath, JSON.stringify({ mcpServers: {} }));
    }
    const result = { configPath: emptyPath, toolPatterns: [] };
    cache.set(cacheKey, { mtime: combinedMtime, ...result });
    return result;
  }

  // Write merged config to temp file
  ensureMergedDir();
  const hash = crypto.createHash('md5')
    .update(JSON.stringify(merged))
    .digest('hex')
    .slice(0, 12);
  const configPath = path.join(MERGED_DIR, `merged-${hash}.json`);

  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, JSON.stringify(merged, null, 2));
    log.info(`MCP config merged: ${toolPatterns.join(', ')} → ${configPath}`);
  }

  const result = { configPath, toolPatterns };
  cache.set(cacheKey, { mtime: combinedMtime, ...result });
  return result;
}

function ensureMergedDir() {
  if (!fs.existsSync(MERGED_DIR)) {
    fs.mkdirSync(MERGED_DIR, { recursive: true });
  }
}

/**
 * Clear cache (useful for testing or hot reload).
 */
function clearCache() {
  cache.clear();
}

module.exports = { buildMcpConfig, clearCache, SYSTEM_MCP_PATH };
