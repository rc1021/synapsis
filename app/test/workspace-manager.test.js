const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const wm = require('../bridges/shared/workspace-manager');

describe('workspace-manager helpers', () => {
  describe('sanitizeId', () => {
    it('removes non-alphanumeric characters', () => {
      assert.equal(wm.sanitizeId('user@123!'), 'user123');
    });

    it('preserves clean IDs', () => {
      assert.equal(wm.sanitizeId('abc123'), 'abc123');
    });

    it('handles empty string', () => {
      assert.equal(wm.sanitizeId(''), '');
    });
  });

  describe('shardPath4', () => {
    it('splits first 8 chars into 4 layers', () => {
      assert.equal(wm.shardPath4('abcdefgh12345678'), path.join('ab', 'cd', 'ef', 'gh'));
    });

    it('pads short IDs', () => {
      assert.equal(wm.shardPath4('ab'), path.join('ab', '00', '00', '00'));
    });
  });

  describe('shardPath2', () => {
    it('splits first 4 chars into 2 layers', () => {
      assert.equal(wm.shardPath2('ABCDEF'), path.join('AB', 'CD'));
    });

    it('pads short IDs', () => {
      assert.equal(wm.shardPath2('A'), path.join('A0', '00'));
    });
  });

  describe('workspaceRelPath', () => {
    it('combines shard path with full ID', () => {
      const wsId = 'a1b2c3d4e5f67890';
      const result = wm.workspaceRelPath(wsId);
      assert.equal(result, path.join('a1', 'b2', 'c3', 'd4', wsId));
    });
  });

  describe('wsIdFromRel', () => {
    it('extracts basename from relative path', () => {
      assert.equal(wm.wsIdFromRel('a1/b2/c3/d4/a1b2c3d4e5f67890'), 'a1b2c3d4e5f67890');
    });
  });
});
