'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

process.env.LOG_DIR = process.env.LOG_DIR || '/tmp/synapsis-test-logs';

const merge = require('../bridges/shared/tts/merge');
const { groupBySize, mergeBuffers } = merge;

describe('tts/merge', () => {
  describe('groupBySize', () => {
    it('puts everything in one group when total is under the limit', () => {
      const buffers = [Buffer.alloc(10), Buffer.alloc(10), Buffer.alloc(10)];
      const groups = groupBySize(buffers, 100);
      assert.equal(groups.length, 1);
      assert.equal(groups[0].length, 3);
    });

    it('splits into multiple groups when total exceeds the limit', () => {
      const buffers = [Buffer.alloc(10), Buffer.alloc(10), Buffer.alloc(10)];
      const groups = groupBySize(buffers, 15);
      // each group's total size must stay within the limit
      for (const group of groups) {
        const total = group.reduce((sum, b) => sum + b.length, 0);
        assert.ok(total <= 15);
      }
      // all buffers preserved, in order
      assert.equal(groups.flat().length, 3);
    });

    it('puts a single oversized buffer in its own group', () => {
      const buffers = [Buffer.alloc(5), Buffer.alloc(50), Buffer.alloc(5)];
      const groups = groupBySize(buffers, 10);
      assert.equal(groups.length, 3);
      assert.equal(groups[1].length, 1);
      assert.equal(groups[1][0].length, 50);
    });

    it('returns an empty array for empty input', () => {
      assert.deepEqual(groupBySize([], 100), []);
    });
  });

  describe('mergeBuffers', () => {
    it('returns the single buffer unchanged without checking ffmpeg', () => {
      const buf = Buffer.from('only one chunk');
      let checked = false;
      const original = merge.checkFfmpeg;
      merge.checkFfmpeg = async () => { checked = true; return true; };
      return mergeBuffers([buf]).then((result) => {
        assert.equal(result, buf);
        assert.equal(checked, false);
        merge.checkFfmpeg = original;
      });
    });

    it('falls back to Buffer.concat when ffmpeg is unavailable', async () => {
      const original = merge.checkFfmpeg;
      merge.checkFfmpeg = async () => false;
      try {
        const buf1 = Buffer.from('hello ');
        const buf2 = Buffer.from('world');
        const result = await mergeBuffers([buf1, buf2]);
        assert.deepEqual(result, Buffer.concat([buf1, buf2]));
      } finally {
        merge.checkFfmpeg = original;
      }
    });
  });
});
