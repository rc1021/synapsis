const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Stub logger before require
const logDir = path.join(os.tmpdir(), 'synapsis-test-logs');
fs.mkdirSync(logDir, { recursive: true });
process.env.LOG_DIR = logDir;

const { buildMcpConfig, clearCache, SYSTEM_MCP_PATH } = require('../bridges/shared/mcp-config');

describe('mcp-config', () => {
  let tmpDir;
  let origSystemContent;

  beforeEach(() => {
    clearCache();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-test-'));
    // Save original system config
    try {
      origSystemContent = fs.readFileSync(SYSTEM_MCP_PATH, 'utf-8');
    } catch {
      origSystemContent = null;
    }
  });

  afterEach(() => {
    // Restore system config
    if (origSystemContent !== null) {
      fs.writeFileSync(SYSTEM_MCP_PATH, origSystemContent);
    }
    // Cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns system MCP servers when no workspace config', () => {
    const result = buildMcpConfig(null);
    assert.ok(result.configPath, 'should have configPath');
    assert.ok(Array.isArray(result.toolPatterns), 'should have toolPatterns array');
    // System config has puppeteer
    assert.ok(result.toolPatterns.includes('mcp__puppeteer__*'), 'should include puppeteer pattern');
  });

  it('returns empty when both system and workspace are empty', () => {
    // Override system config to empty
    fs.writeFileSync(SYSTEM_MCP_PATH, JSON.stringify({ mcpServers: {} }));
    clearCache();

    const wsDir = path.join(tmpDir, 'ws1');
    fs.mkdirSync(wsDir, { recursive: true });
    fs.writeFileSync(path.join(wsDir, '.mcp.json'), JSON.stringify({ mcpServers: {} }));

    const result = buildMcpConfig(wsDir);
    assert.equal(result.toolPatterns.length, 0, 'should have no tool patterns');
  });

  it('merges system and workspace configs', () => {
    const wsDir = path.join(tmpDir, 'ws2');
    fs.mkdirSync(wsDir, { recursive: true });
    fs.writeFileSync(path.join(wsDir, '.mcp.json'), JSON.stringify({
      mcpServers: {
        notion: {
          command: 'npx',
          args: ['-y', '@anthropic-ai/mcp-server-notion'],
          env: { NOTION_API_KEY: 'test-key' },
        },
      },
    }));

    const result = buildMcpConfig(wsDir);
    assert.ok(result.toolPatterns.includes('mcp__puppeteer__*'), 'should include system puppeteer');
    assert.ok(result.toolPatterns.includes('mcp__notion__*'), 'should include workspace notion');

    // Verify merged file content
    const merged = JSON.parse(fs.readFileSync(result.configPath, 'utf-8'));
    assert.ok(merged.mcpServers.puppeteer, 'merged should have puppeteer');
    assert.ok(merged.mcpServers.notion, 'merged should have notion');
  });

  it('workspace overrides system server with same name', () => {
    const wsDir = path.join(tmpDir, 'ws3');
    fs.mkdirSync(wsDir, { recursive: true });
    fs.writeFileSync(path.join(wsDir, '.mcp.json'), JSON.stringify({
      mcpServers: {
        puppeteer: {
          command: 'custom-puppeteer',
          args: ['--custom'],
        },
      },
    }));

    const result = buildMcpConfig(wsDir);
    const merged = JSON.parse(fs.readFileSync(result.configPath, 'utf-8'));
    assert.equal(merged.mcpServers.puppeteer.command, 'custom-puppeteer', 'workspace should override system');
  });

  it('caches result until mtime changes', () => {
    const result1 = buildMcpConfig(null);
    const result2 = buildMcpConfig(null);
    assert.equal(result1.configPath, result2.configPath, 'cached result should be same path');
  });

  it('handles missing workspace .mcp.json gracefully', () => {
    const wsDir = path.join(tmpDir, 'ws-no-mcp');
    fs.mkdirSync(wsDir, { recursive: true });
    // No .mcp.json in workspace

    const result = buildMcpConfig(wsDir);
    assert.ok(result.configPath, 'should still return configPath');
    // Should still have system servers
    assert.ok(result.toolPatterns.includes('mcp__puppeteer__*'), 'should include system puppeteer');
  });
});
