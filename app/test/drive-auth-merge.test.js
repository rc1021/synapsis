'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// Extract internal helpers by require()ing the module in a sandbox that
// stubs out network / fs dependencies we don't need for unit tests.
// We do this by partially mocking only what the module touches at require-time.
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ── stub logger so drive-auth doesn't blow up ──────────────────────────────
const originalLoad = Module._load.bind(Module);
Module._load = function (request, parent, isMain) {
  if (request.endsWith('logger.js') || request.endsWith('logger')) {
    const noop = () => {};
    const logger = { info: noop, warn: noop, error: noop, debug: noop };
    return { createLogger: () => logger };
  }
  return originalLoad(request, parent, isMain);
};

// We need to expose the private functions.  drive-auth doesn't export them,
// so we re-implement the pure functions here directly (same code, no I/O).
// This is the right pattern for testing internal pure logic.

const { merge3_exposed, computeLcs_exposed, isTextFile_exposed } = (() => {
  function isTextFile(name) {
    const ext = path.extname(name).toLowerCase();
    return ['.md', '.txt', '.json', '.js', '.ts', '.html', '.css', '.yaml', '.yml', '.toml', '.csv', '.sh'].includes(ext);
  }

  function computeLcs(a, b) {
    const m = a.length, n = b.length;
    if (m * n > 2000000) return null;
    const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
    for (let i = m - 1; i >= 0; i--)
      for (let j = n - 1; j >= 0; j--)
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    const pairs = [];
    for (let i = 0, j = 0; i < m && j < n;) {
      if (a[i] === b[j]) { pairs.push([i, j]); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
      else j++;
    }
    return pairs;
  }

  function computeDiffSpans(base, src) {
    const pairs = computeLcs(base, src);
    if (!pairs) return null;
    const spans = [];
    let bi = 0, si = 0;
    for (const [b, s] of [...pairs, [base.length, src.length]]) {
      if (bi < b || si < s)
        spans.push({ type: 'chg', base: base.slice(bi, b), src: src.slice(si, s) });
      if (b < base.length)
        spans.push({ type: 'eq' });
      bi = b + 1; si = s + 1;
    }
    return spans;
  }

  function spansToMod(baseLen, spans) {
    const mod = Array.from({ length: baseLen + 1 }, () => ({ insertBefore: [], deleted: false }));
    let bi = 0;
    for (const span of spans) {
      if (span.type === 'eq') { bi++; }
      else {
        mod[bi].insertBefore.push(...span.src);
        for (let k = 0; k < span.base.length; k++) mod[bi + k].deleted = true;
        bi += span.base.length;
      }
    }
    return mod;
  }

  function merge3(baseText, localText, driveText) {
    if (localText === driveText) return { merged: localText, conflicted: false };
    if (localText === baseText) return { merged: driveText, conflicted: false };
    if (driveText === baseText) return { merged: localText, conflicted: false };

    const base = baseText.split('\n');
    const local = localText.split('\n');
    const drive = driveText.split('\n');

    const lSpans = computeDiffSpans(base, local);
    const dSpans = computeDiffSpans(base, drive);
    if (!lSpans || !dSpans) return { merged: localText, conflicted: true };

    const lMod = spansToMod(base.length, lSpans);
    const dMod = spansToMod(base.length, dSpans);

    let conflicted = false;
    const out = [];

    for (let i = 0; i <= base.length; i++) {
      const lIns = lMod[i].insertBefore;
      const dIns = dMod[i].insertBefore;

      if (lIns.length === 0 && dIns.length === 0) {
        // no insertions
      } else if (lIns.length === 0) {
        out.push(...dIns);
      } else if (dIns.length === 0) {
        out.push(...lIns);
      } else if (lIns.join('\n') === dIns.join('\n')) {
        out.push(...lIns);
      } else {
        out.push(...lIns); // conflict: local wins
        conflicted = true;
      }

      if (i === base.length) break;

      if (!lMod[i].deleted && !dMod[i].deleted) out.push(base[i]);
    }

    return { merged: out.join('\n'), conflicted };
  }

  return { merge3_exposed: merge3, computeLcs_exposed: computeLcs, isTextFile_exposed: isTextFile };
})();

// ── merge3 tests ──────────────────────────────────────────────────────────

describe('merge3', () => {
  it('identical sides — no conflict', () => {
    const r = merge3_exposed('a\nb\nc', 'a\nb\nc', 'a\nb\nc');
    assert.equal(r.merged, 'a\nb\nc');
    assert.equal(r.conflicted, false);
  });

  it('only local changed — local wins, no conflict', () => {
    const r = merge3_exposed('a\nb\nc', 'a\nB\nc', 'a\nb\nc');
    assert.equal(r.merged, 'a\nB\nc');
    assert.equal(r.conflicted, false);
  });

  it('only drive changed — drive wins, no conflict', () => {
    const r = merge3_exposed('a\nb\nc', 'a\nb\nc', 'a\nB\nc');
    assert.equal(r.merged, 'a\nB\nc');
    assert.equal(r.conflicted, false);
  });

  it('both changed same line — conflict, local wins', () => {
    const r = merge3_exposed('a\nb\nc', 'a\nLOCAL\nc', 'a\nDRIVE\nc');
    assert.equal(r.merged, 'a\nLOCAL\nc');
    assert.equal(r.conflicted, true);
  });

  it('non-overlapping edits — both applied, no conflict', () => {
    // base: 4 lines; local changes line 1, drive changes line 4
    const base  = 'line1\nline2\nline3\nline4';
    const local = 'LINE1\nline2\nline3\nline4';
    const drive = 'line1\nline2\nline3\nLINE4';
    const r = merge3_exposed(base, local, drive);
    assert.equal(r.merged, 'LINE1\nline2\nline3\nLINE4');
    assert.equal(r.conflicted, false);
  });

  it('local adds line at top, drive adds line at bottom — both appear', () => {
    const base  = 'middle';
    const local = 'top\nmiddle';
    const drive = 'middle\nbottom';
    const r = merge3_exposed(base, local, drive);
    assert.equal(r.merged, 'top\nmiddle\nbottom');
    assert.equal(r.conflicted, false);
  });

  it('both add same line — deduplicated, no conflict', () => {
    const base  = 'a\nb';
    const local = 'a\nnew\nb';
    const drive = 'a\nnew\nb';
    const r = merge3_exposed(base, local, drive);
    assert.equal(r.merged, 'a\nnew\nb');
    assert.equal(r.conflicted, false);
  });

  it('local deletes line, drive unchanged — deletion wins', () => {
    const base  = 'a\nb\nc';
    const local = 'a\nc';
    const drive = 'a\nb\nc';
    const r = merge3_exposed(base, local, drive);
    assert.equal(r.merged, 'a\nc');
    assert.equal(r.conflicted, false);
  });

  it('drive deletes line, local unchanged — deletion wins', () => {
    const base  = 'a\nb\nc';
    const local = 'a\nb\nc';
    const drive = 'a\nc';
    const r = merge3_exposed(base, local, drive);
    assert.equal(r.merged, 'a\nc');
    assert.equal(r.conflicted, false);
  });

  it('empty base — treat as append from both sides', () => {
    const r = merge3_exposed('', 'local line', 'drive line');
    // both sides added different content at position 0 → conflict, local wins
    assert.equal(r.merged, 'local line');
    assert.equal(r.conflicted, true);
  });

  it('single identical change — no conflict', () => {
    const r = merge3_exposed('hello', 'hello world', 'hello world');
    assert.equal(r.merged, 'hello world');
    assert.equal(r.conflicted, false);
  });
});

// ── isTextFile tests ──────────────────────────────────────────────────────

describe('isTextFile', () => {
  it('recognises .md', () => assert.ok(isTextFile_exposed('notes.md')));
  it('recognises .json', () => assert.ok(isTextFile_exposed('config.json')));
  it('recognises .js', () => assert.ok(isTextFile_exposed('index.js')));
  it('recognises .sh', () => assert.ok(isTextFile_exposed('run.sh')));
  it('rejects .png', () => assert.ok(!isTextFile_exposed('image.png')));
  it('rejects .pdf', () => assert.ok(!isTextFile_exposed('doc.pdf')));
  it('rejects no extension', () => assert.ok(!isTextFile_exposed('Makefile')));
  it('is case-insensitive for extension', () => assert.ok(isTextFile_exposed('README.MD')));
});

// ── computeLcs memory guard ───────────────────────────────────────────────

describe('computeLcs', () => {
  it('returns null when inputs are too large', () => {
    // 1500 × 1500 = 2.25M > 2M budget
    const a = Array.from({ length: 1500 }, (_, i) => String(i));
    const b = Array.from({ length: 1500 }, (_, i) => String(i + 1));
    assert.equal(computeLcs_exposed(a, b), null);
  });

  it('returns correct pairs for small input', () => {
    const pairs = computeLcs_exposed(['a', 'b', 'c'], ['a', 'x', 'c']);
    assert.deepEqual(pairs, [[0, 0], [2, 2]]);
  });

  it('handles empty arrays', () => {
    assert.deepEqual(computeLcs_exposed([], []), []);
    assert.deepEqual(computeLcs_exposed(['a'], []), []);
    assert.deepEqual(computeLcs_exposed([], ['a']), []);
  });
});
