'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { chunkText } = require('../bridges/shared/tts/chunk');

describe('tts/chunk', () => {
  it('throws if neither maxBytes nor maxChars is given', () => {
    assert.throws(() => chunkText('hello', {}));
  });

  it('returns empty array for empty input', () => {
    assert.deepEqual(chunkText('', { maxChars: 100 }), []);
  });

  it('returns empty array for whitespace-only input', () => {
    assert.deepEqual(chunkText('   \n\n  ', { maxChars: 100 }), []);
  });

  it('returns a single chunk when text fits under the limit', () => {
    assert.deepEqual(chunkText('Hello world.', { maxChars: 100 }), ['Hello world.']);
  });

  it('packs short paragraphs into a single chunk when they fit together', () => {
    assert.deepEqual(chunkText('a\n\nb', { maxChars: 100 }), ['a\n\nb']);
  });

  it('splits on paragraph boundaries when paragraphs do not fit together', () => {
    const chunks = chunkText('hello\n\nworld', { maxChars: 5 });
    assert.deepEqual(chunks, ['hello', 'world']);
    for (const c of chunks) assert.ok(c.length <= 5);
  });

  it('splits an oversized paragraph on sentence boundaries', () => {
    const chunks = chunkText('Hi. Yo. Ok.', { maxChars: 4 });
    assert.deepEqual(chunks, ['Hi.', 'Yo.', 'Ok.']);
    for (const c of chunks) assert.ok(c.length <= 4);
  });

  it('hard-splits unbroken text with no punctuation', () => {
    const chunks = chunkText('abcdefgh', { maxChars: 3 });
    assert.deepEqual(chunks, ['abc', 'def', 'gh']);
    for (const c of chunks) assert.ok(c.length <= 3);
  });

  it('never produces empty or whitespace-only chunks', () => {
    const chunks = chunkText('hello\n\nworld', { maxChars: 5 });
    for (const c of chunks) assert.ok(c.trim().length > 0);
  });

  it('byte-mode: never exceeds maxBytes and never splits a multi-byte character', () => {
    const text = '中文測試文字';
    const maxBytes = 5; // not divisible by 3 (each CJK char is 3 bytes in UTF-8)
    const chunks = chunkText(text, { maxBytes });

    for (const c of chunks) {
      assert.ok(Buffer.byteLength(c, 'utf-8') <= maxBytes);
      // every chunk must consist of whole characters
      assert.ok(Array.from(c).length > 0);
    }

    // concatenation reconstructs the original text
    assert.equal(chunks.join(''), text);
  });

  it('char-mode: respects maxChars for ASCII text', () => {
    const text = 'a'.repeat(20);
    const chunks = chunkText(text, { maxChars: 7 });
    for (const c of chunks) assert.ok(c.length <= 7);
    assert.equal(chunks.join(''), text);
  });
});
