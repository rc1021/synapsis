'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { extractKeywords } = require('../bridges/shared/keyword-extract');

describe('extractKeywords', () => {
  it('finds a shared CJK bigram across undelimited filenames', () => {
    const result = extractKeywords(['下雨天心情.md', '下雨筆記.md', 'SOUL.md']);
    const terms = result.map(r => r.term);
    assert.ok(terms.includes('下雨'));
    const entry = result.find(r => r.term === '下雨');
    assert.equal(entry.count, 2);
  });

  it('finds shared ASCII words across delimited filenames', () => {
    const result = extractKeywords(['weekly-review-23.md', 'weekly-review-24.md', 'other.md']);
    const terms = result.map(r => r.term);
    assert.ok(terms.includes('weekly'));
    assert.ok(terms.includes('review'));
  });

  it('strips date-like fragments before extracting', () => {
    const result = extractKeywords(['2026-06-09-下雨筆記.md', '2026-06-10-下雨筆記.md']);
    const terms = result.map(r => r.term);
    assert.ok(!terms.some(t => /\d/.test(t)));
    assert.ok(terms.includes('筆記'));
  });

  it('excludes terms that appear in only one name', () => {
    const result = extractKeywords(['投資組合.md', '學習筆記.md']);
    assert.deepEqual(result, []);
  });

  it('returns at most topN results, ranked by document frequency', () => {
    const names = ['下雨天.md', '下雨筆記.md', '下雨心情.md', '今天天氣.md', '今天筆記.md'];
    const result = extractKeywords(names, 1);
    assert.equal(result.length, 1);
    assert.equal(result[0].term, '下雨');
    assert.equal(result[0].count, 3);
  });

  it('returns an empty array for an empty input', () => {
    assert.deepEqual(extractKeywords([]), []);
  });
});
