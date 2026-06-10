'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { toSpeechText } = require('../bridges/shared/markdown-to-speech');

describe('markdown-to-speech', () => {
  describe('headers', () => {
    it('converts a header into a sentence', () => {
      assert.equal(toSpeechText('# Hello World'), 'Hello World。');
    });

    it('handles h1-h6', () => {
      assert.equal(toSpeechText('###### Deep header'), 'Deep header。');
    });

    it('does not double-punctuate a header that already ends with punctuation', () => {
      assert.equal(toSpeechText('# 標題！'), '標題！');
    });
  });

  describe('inline markdown', () => {
    it('strips bold, italic, strikethrough, inline code', () => {
      assert.equal(toSpeechText('**bold** *italic* ~~strike~~ `code`'), 'bold italic strike code');
    });

    it('strips __bold__ and _italic_', () => {
      assert.equal(toSpeechText('__bold__ and _italic_'), 'bold and italic');
    });

    it('keeps link text but drops the url', () => {
      assert.equal(toSpeechText('[連結文字](https://example.com)'), '連結文字');
    });

    it('drops images entirely', () => {
      assert.equal(toSpeechText('![alt text](https://example.com/image.png)'), '');
    });
  });

  describe('code blocks', () => {
    it('drops fenced code blocks', () => {
      assert.equal(toSpeechText('Some text\n```js\nconst x = 1;\n```\nMore text'), 'Some text\n\nMore text');
    });

    it('drops unterminated fenced code blocks', () => {
      assert.equal(toSpeechText('Text before\n```js\nconst x = 1;'), 'Text before');
    });
  });

  describe('blockquotes', () => {
    it('strips a single blockquote marker', () => {
      assert.equal(toSpeechText('> quote line'), 'quote line');
    });

    it('strips nested blockquote markers', () => {
      assert.equal(toSpeechText('>> nested quote'), 'nested quote');
    });

    it('strips spaced nested blockquote markers', () => {
      assert.equal(toSpeechText('> > nested quote'), 'nested quote');
    });
  });

  describe('horizontal rules', () => {
    it('drops --- on its own line', () => {
      assert.equal(toSpeechText('Above\n\n---\n\nBelow'), 'Above\n\nBelow');
    });

    it('drops *** on its own line', () => {
      assert.equal(toSpeechText('Above\n\n***\n\nBelow'), 'Above\n\nBelow');
    });

    it('drops ___ on its own line', () => {
      assert.equal(toSpeechText('Above\n\n___\n\nBelow'), 'Above\n\nBelow');
    });
  });

  describe('HTML comments', () => {
    it('strips HTML comments spanning multiple lines', () => {
      assert.equal(toSpeechText('Before\n<!-- this is a comment\nspanning lines -->\nAfter'), 'Before\n\nAfter');
    });
  });

  describe('lists', () => {
    it('converts unordered list items into sentences', () => {
      assert.equal(toSpeechText('- item one\n- item two'), 'item one。\nitem two。');
    });

    it('converts ordered list items into sentences', () => {
      assert.equal(toSpeechText('1. first\n2. second'), 'first。\nsecond。');
    });

    it('converts nested unordered list items', () => {
      assert.equal(toSpeechText('- parent\n  - child'), 'parent。\nchild。');
    });

    it('converts task list items, dropping the checkbox', () => {
      assert.equal(toSpeechText('- [ ] todo item\n- [x] done item'), 'todo item。\ndone item。');
    });
  });

  describe('table conversion', () => {
    it('converts a table into spoken sentences', () => {
      const md = [
        '| Name | Status |',
        '|------|--------|',
        '| Alice | Done |',
        '| Bob |  |',
      ].join('\n');
      assert.equal(toSpeechText(md), 'Name: Alice，Status: Done。\nName: Bob，Status: 無。');
    });

    it('strips inline markdown inside table cells', () => {
      const md = [
        '| **Name** | Status |',
        '|------|--------|',
        '| **Alice** | `Done` |',
      ].join('\n');
      assert.equal(toSpeechText(md), 'Name: Alice，Status: Done。');
    });

    it('leaves non-table lines containing | untouched', () => {
      assert.equal(toSpeechText('Use the | character carefully'), 'Use the | character carefully');
    });
  });

  describe('mixed document', () => {
    it('produces clean speech text with no leftover markdown syntax', () => {
      const md = [
        '# 標題',
        '',
        '**重要** 提示，包含 *斜體* 和 ~~刪除線~~ 還有 `code`。',
        '',
        '- 項目一',
        '- 項目二',
        '',
        '| 欄位A | 欄位B |',
        '|---|---|',
        '| 值1 | 值2 |',
        '',
        '> 引用文字',
        '',
        '---',
        '',
        '[連結文字](https://example.com)',
      ].join('\n');

      const result = toSpeechText(md);

      assert.ok(!result.includes('#'), 'should not contain #');
      assert.ok(!result.includes('**'), 'should not contain **');
      assert.ok(!result.includes('~~'), 'should not contain ~~');
      assert.ok(!result.includes('`'), 'should not contain `');
      assert.ok(!result.includes('|'), 'should not contain |');
      assert.ok(!result.includes('---'), 'should not contain ---');
      assert.ok(result.includes('標題'));
      assert.ok(result.includes('連結文字'));
      assert.ok(result.includes('欄位A: 值1，欄位B: 值2。'));
    });
  });

  describe('edge cases', () => {
    it('returns empty string for empty input', () => {
      assert.equal(toSpeechText(''), '');
    });

    it('returns empty string for whitespace-only input', () => {
      assert.equal(toSpeechText('   \n\n  '), '');
    });
  });
});
