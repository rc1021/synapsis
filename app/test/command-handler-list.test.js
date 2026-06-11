'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const wm = require('../bridges/shared/workspace-manager');
const { handleCommand } = require('../bridges/shared/command-handler');

describe('/list command', () => {
  let wsDir;
  let restoreResolveWorkspace;
  let restoreReadIndex;

  before(() => {
    wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'list-test-'));
    fs.mkdirSync(path.join(wsDir, 'memory'));
    fs.mkdirSync(path.join(wsDir, 'memory', 'archive'));
    fs.writeFileSync(path.join(wsDir, 'memory', '下雨天心情.md'), 'x');
    fs.writeFileSync(path.join(wsDir, 'memory', '2026-06-09-下雨筆記.md'), 'x');
    for (let i = 1; i <= 60; i++) {
      fs.writeFileSync(path.join(wsDir, 'memory', `2026-03-${String(i).padStart(2, '0')}.md`), 'x');
    }

    restoreResolveWorkspace = wm.resolveWorkspace;
    restoreReadIndex = wm.readIndex;
    wm.resolveWorkspace = () => wsDir;
    wm.readIndex = () => 'fake-ws';
  });

  after(() => {
    wm.resolveWorkspace = restoreResolveWorkspace;
    wm.readIndex = restoreReadIndex;
    fs.rmSync(wsDir, { recursive: true, force: true });
  });

  const list = (args) => handleCommand('discord', 'u1', { command: 'list', args }, {});

  it('filters items by keyword and highlights the match', () => {
    const result = list(['memory', '下雨']);
    assert.match(result.reply, /符合「下雨」/);
    assert.match(result.reply, /\[下雨\]天心情\.md/);
    assert.match(result.reply, /2026-06-09-\[下雨\]筆記\.md/);
    assert.doesNotMatch(result.reply, /2026-03-01/);
  });

  it('returns a count-only summary', () => {
    const result = list(['memory', '', '--count']);
    assert.match(result.reply, /：63 項（1 資料夾、62 檔案）/);
    assert.doesNotMatch(result.reply, /📄/);
  });

  it('combines count with filter', () => {
    const result = list(['memory', '下雨', '--count']);
    assert.match(result.reply, /：2 項，符合「下雨」（0 資料夾、2 檔案）/);
  });

  it('keeps the keyword line in the header even when the listing is too long to fit', () => {
    const result = list(['memory', '', '--keywords']);
    assert.match(result.reply, /🔑 關鍵字/);
    assert.match(result.reply, /下雨/);
    assert.ok(result.file, 'expected a file attachment for the full listing');
    assert.equal(result.file.name, 'list.txt');
    assert.match(result.file.content, /2026-03-01\.md/);
    assert.match(result.file.content, /2026-03-60\.md/);
  });

  it('does not attach a file for a short listing', () => {
    const result = list(['memory', '下雨']);
    assert.equal(result.file, undefined);
  });

  it('reports no matches without truncation noise', () => {
    const result = list(['memory', 'zzz']);
    assert.match(result.reply, /沒有符合「zzz」的項目/);
  });
});
