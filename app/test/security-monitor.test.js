const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// Stub logger before requiring security-monitor
const origEnv = process.env.LOG_DIR;
process.env.LOG_DIR = '/tmp/synapsis-test-logs';

const sm = require('../bridges/shared/security-monitor');

describe('security-monitor', () => {
  const wsPath = '/workspace/user123';

  describe('checkToolCall', () => {
    it('returns null for safe file access within workspace', () => {
      const result = sm.checkToolCall('Read', { file_path: '/workspace/user123/MEMORY.md' }, wsPath);
      assert.equal(result, null);
    });

    it('detects path escape via absolute path', () => {
      const result = sm.checkToolCall('Read', { file_path: '/etc/passwd' }, wsPath);
      assert.ok(result);
      assert.equal(result.violation, true);
      assert.match(result.reason, /path escape/);
    });

    it('detects path traversal via ../', () => {
      const result = sm.checkToolCall('Read', { file_path: '../../etc/passwd' }, wsPath);
      assert.ok(result);
      assert.equal(result.violation, true);
    });

    it('detects glob pattern traversal', () => {
      const result = sm.checkToolCall('Glob', { pattern: '../**/*.md' }, wsPath);
      assert.ok(result);
      assert.equal(result.violation, true);
      assert.match(result.reason, /glob pattern traversal/);
    });

    it('allows safe glob patterns', () => {
      const result = sm.checkToolCall('Glob', { pattern: '**/*.md' }, wsPath);
      assert.equal(result, null);
    });

    it('detects symlink creation via bash', () => {
      const result = sm.checkToolCall('Bash', { command: 'ln -s /etc/passwd link' }, wsPath);
      assert.ok(result);
      assert.equal(result.violation, true);
      assert.match(result.reason, /symlink/);
    });

    it('detects bash file access outside workspace', () => {
      const result = sm.checkToolCall('Bash', { command: 'cat /etc/shadow' }, wsPath);
      assert.ok(result);
      assert.equal(result.violation, true);
      assert.match(result.reason, /bash file access outside/);
    });

    it('allows bash commands targeting workspace files', () => {
      const result = sm.checkToolCall('Bash', { command: `cat ${wsPath}/notes.md` }, wsPath);
      assert.equal(result, null);
    });

    it('returns null when wsPath is empty', () => {
      const result = sm.checkToolCall('Read', { file_path: '/etc/passwd' }, '');
      assert.equal(result, null);
    });

    it('checks multiple path fields', () => {
      const result = sm.checkToolCall('Write', { path: '/tmp/evil', file_path: `${wsPath}/ok.md` }, wsPath);
      assert.ok(result);
      assert.equal(result.violation, true);
    });
  });

  describe('violation tracking', () => {
    const testWs = '/workspace/test-violations';

    it('starts with zero violations', () => {
      sm.resetViolations(testWs);
      assert.equal(sm.getViolationCount(testWs), 0);
    });

    it('should not kill session under 6 violations', () => {
      sm.resetViolations(testWs);
      assert.equal(sm.shouldKillSession(testWs), false);
    });

    it('resets violations', () => {
      sm.resetViolations(testWs);
      assert.equal(sm.getViolationCount(testWs), 0);
    });
  });
});

// Restore env
if (origEnv !== undefined) {
  process.env.LOG_DIR = origEnv;
} else {
  delete process.env.LOG_DIR;
}
