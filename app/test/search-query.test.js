'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseDateHints,
  extractNoteDate,
  noteMatchesDate,
  rangesOverlap,
  lexicalScore,
  isTrivialQuery,
} = require('../bridges/shared/search-query');

// Fixed reference "now" for deterministic relative-date tests: 2026-06-11 (June)
const NOW = new Date(2026, 5, 11);

describe('search-query', () => {
  describe('parseDateHints — absolute dates', () => {
    it('parses YYYY-MM-DD into a single-day range', () => {
      const { ranges, cleanedQuery } = parseDateHints('2026-05-11 的筆記', NOW);
      assert.equal(ranges.length, 1);
      assert.deepEqual(ranges[0], { start: new Date(2026, 4, 11), end: new Date(2026, 4, 12) });
      assert.ok(isTrivialQuery(cleanedQuery));
    });

    it('parses YYYY年MM月DD日', () => {
      const { ranges } = parseDateHints('2026年5月11日的筆記', NOW);
      assert.equal(ranges.length, 1);
      assert.deepEqual(ranges[0], { start: new Date(2026, 4, 11), end: new Date(2026, 4, 12) });
    });

    it('parses YYYY-MM into a month range', () => {
      const { ranges } = parseDateHints('2026-05 的筆記', NOW);
      assert.equal(ranges.length, 1);
      assert.deepEqual(ranges[0], { start: new Date(2026, 4, 1), end: new Date(2026, 5, 1) });
    });

    it('parses a standalone year', () => {
      const { ranges } = parseDateHints('2026年的筆記', NOW);
      assert.equal(ranges.length, 1);
      assert.deepEqual(ranges[0], { start: new Date(2026, 0, 1), end: new Date(2027, 0, 1) });
    });
  });

  describe('parseDateHints — month ranges', () => {
    it('parses "X到Y月" using the current year', () => {
      const { ranges, cleanedQuery } = parseDateHints('4到5月的筆記', NOW);
      assert.equal(ranges.length, 1);
      assert.deepEqual(ranges[0], { start: new Date(2026, 3, 1), end: new Date(2026, 5, 1) });
      assert.ok(isTrivialQuery(cleanedQuery));
    });

    it('parses "X月到Y月"', () => {
      const { ranges } = parseDateHints('4月到5月', NOW);
      assert.equal(ranges.length, 1);
      assert.deepEqual(ranges[0], { start: new Date(2026, 3, 1), end: new Date(2026, 5, 1) });
    });

    it('parses an explicit-year month range', () => {
      const { ranges } = parseDateHints('2026年4到5月', NOW);
      assert.equal(ranges.length, 1);
      assert.deepEqual(ranges[0], { start: new Date(2026, 3, 1), end: new Date(2026, 5, 1) });
    });

    it('rolls over to next year when the range wraps Dec→Jan', () => {
      const { ranges } = parseDateHints('11到2月', NOW);
      assert.equal(ranges.length, 1);
      assert.deepEqual(ranges[0], { start: new Date(2026, 10, 1), end: new Date(2027, 2, 1) });
    });
  });

  describe('parseDateHints — month only', () => {
    it('uses the current year when the month has already occurred', () => {
      const { ranges } = parseDateHints('5月的筆記', NOW);
      assert.deepEqual(ranges[0], { start: new Date(2026, 4, 1), end: new Date(2026, 5, 1) });
    });

    it('uses last year when the month has not happened yet this year', () => {
      const { ranges } = parseDateHints('12月的筆記', NOW);
      assert.deepEqual(ranges[0], { start: new Date(2025, 11, 1), end: new Date(2026, 0, 1) });
    });
  });

  describe('parseDateHints — relative day', () => {
    it('handles 今天/昨天/前天', () => {
      const today = new Date(2026, 5, 11);
      assert.deepEqual(parseDateHints('今天的筆記', NOW).ranges[0], { start: today, end: new Date(2026, 5, 12) });
      assert.deepEqual(parseDateHints('昨天的筆記', NOW).ranges[0], { start: new Date(2026, 5, 10), end: today });
      assert.deepEqual(parseDateHints('前天的筆記', NOW).ranges[0], { start: new Date(2026, 5, 9), end: new Date(2026, 5, 10) });
    });
  });

  describe('parseDateHints — relative week', () => {
    it('produces adjacent 7-day Monday-start ranges for 這週/上週', () => {
      const thisWeek = parseDateHints('這週的筆記', NOW).ranges[0];
      const lastWeek = parseDateHints('上週的筆記', NOW).ranges[0];

      assert.equal(thisWeek.start.getDay(), 1); // Monday
      assert.equal((thisWeek.end - thisWeek.start) / 86400000, 7);
      assert.ok(thisWeek.start <= NOW && NOW < thisWeek.end);

      assert.equal((lastWeek.end - lastWeek.start) / 86400000, 7);
      assert.deepEqual(lastWeek.end, thisWeek.start);
    });

    it('上上週 is two weeks before 這週', () => {
      const thisWeek = parseDateHints('這週的筆記', NOW).ranges[0];
      const twoWeeksAgo = parseDateHints('上上週的筆記', NOW).ranges[0];
      assert.equal((thisWeek.start - twoWeeksAgo.start) / 86400000, 14);
    });
  });

  describe('parseDateHints — relative month/year', () => {
    it('handles 這個月/上個月', () => {
      const thisMonth = parseDateHints('這個月的筆記', NOW).ranges[0];
      const lastMonth = parseDateHints('上個月的筆記', NOW).ranges[0];
      assert.deepEqual(thisMonth, { start: new Date(2026, 5, 1), end: new Date(2026, 6, 1) });
      assert.deepEqual(lastMonth, { start: new Date(2026, 4, 1), end: new Date(2026, 5, 1) });
    });

    it('handles 今年/去年/前年', () => {
      assert.deepEqual(parseDateHints('今年的筆記', NOW).ranges[0], { start: new Date(2026, 0, 1), end: new Date(2027, 0, 1) });
      assert.deepEqual(parseDateHints('去年的筆記', NOW).ranges[0], { start: new Date(2025, 0, 1), end: new Date(2026, 0, 1) });
      assert.deepEqual(parseDateHints('前年的筆記', NOW).ranges[0], { start: new Date(2024, 0, 1), end: new Date(2025, 0, 1) });
    });
  });

  describe('parseDateHints — 最近', () => {
    it('covers the last 14 days including today', () => {
      const { ranges } = parseDateHints('最近的筆記', NOW);
      assert.deepEqual(ranges[0], { start: new Date(2026, 4, 28), end: new Date(2026, 5, 12) });
    });
  });

  describe('parseDateHints — no date hints', () => {
    it('returns no ranges and the original query for a topical search', () => {
      const { ranges, cleanedQuery } = parseDateHints('投資組合再平衡的想法', NOW);
      assert.equal(ranges.length, 0);
      assert.equal(cleanedQuery, '投資組合再平衡的想法');
    });
  });

  describe('extractNoteDate', () => {
    it('extracts a daily-note date', () => {
      assert.deepEqual(extractNoteDate('memory/2026-05-11.md'), { start: new Date(2026, 4, 11), end: new Date(2026, 4, 12) });
    });

    it('extracts a monthly-note range', () => {
      assert.deepEqual(extractNoteDate('memory/2026-05.md'), { start: new Date(2026, 4, 1), end: new Date(2026, 5, 1) });
    });

    it('extracts an ISO week range that contains Jan 4th of that year', () => {
      const range = extractNoteDate('memory/weekly/2026-W01.md');
      const jan4 = new Date(2026, 0, 4);
      assert.equal((range.end - range.start) / 86400000, 7);
      assert.equal(range.start.getDay(), 1); // Monday
      assert.ok(range.start <= jan4 && jan4 < range.end);
    });

    it('returns null when the path has no date pattern', () => {
      assert.equal(extractNoteDate('memory/learning/series-index.md'), null);
    });
  });

  describe('noteMatchesDate', () => {
    const aprMay = { start: new Date(2026, 3, 1), end: new Date(2026, 5, 1) };

    it('matches a daily note inside the range', () => {
      assert.equal(noteMatchesDate('memory/2026-05-11.md', [aprMay]), true);
    });

    it('does not match a daily note outside the range', () => {
      assert.equal(noteMatchesDate('memory/2026-03-03.md', [aprMay]), false);
    });

    it('returns false when there are no query ranges', () => {
      assert.equal(noteMatchesDate('memory/2026-05-11.md', []), false);
    });

    it('returns false for paths with no date pattern', () => {
      assert.equal(noteMatchesDate('memory/learning/series-index.md', [aprMay]), false);
    });
  });

  describe('rangesOverlap', () => {
    it('detects overlap and non-overlap', () => {
      const a = { start: new Date(2026, 0, 1), end: new Date(2026, 2, 1) };
      const b = { start: new Date(2026, 1, 1), end: new Date(2026, 3, 1) };
      const c = { start: new Date(2026, 3, 1), end: new Date(2026, 4, 1) };
      assert.equal(rangesOverlap(a, b), true);
      assert.equal(rangesOverlap(a, c), false);
    });
  });

  describe('lexicalScore', () => {
    it('scores 1 when the query mentions the filename', () => {
      const note = { key: 'SOUL.md', title: 'Soul', tags: [] };
      assert.equal(lexicalScore('找 soul.md 的內容', note), 1);
    });

    it('scores 0.9 on title containment', () => {
      const note = { key: 'memory/weekly/2026-W23.md', title: 'Weekly Review — 2026-W23', tags: [] };
      assert.equal(lexicalScore('weekly review', note), 0.9);
    });

    it('scores 0.8 on tag match', () => {
      const note = { key: 'memory/learning/x.md', title: 'X', tags: ['投資'] };
      assert.equal(lexicalScore('投資相關的筆記', note), 0.8);
    });

    it('scores 0 when nothing matches', () => {
      const note = { key: 'memory/learning/series-index.md', title: '學習筆記索引', tags: [] };
      assert.equal(lexicalScore('投資組合再平衡', note), 0);
    });

    it('scores 0 for an empty query', () => {
      const note = { key: 'SOUL.md', title: 'Soul', tags: [] };
      assert.equal(lexicalScore('', note), 0);
    });
  });

  describe('isTrivialQuery', () => {
    it('treats stopword-only text as trivial', () => {
      assert.equal(isTrivialQuery('的筆記'), true);
      assert.equal(isTrivialQuery('  '), true);
      assert.equal(isTrivialQuery(''), true);
    });

    it('treats text with topical content as non-trivial', () => {
      assert.equal(isTrivialQuery('投資組合'), false);
    });
  });
});
