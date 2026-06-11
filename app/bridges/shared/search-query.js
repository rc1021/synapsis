/**
 * Query understanding for /search — extracts date-range hints from a
 * natural-language query (absolute dates, month ranges, relative
 * day/week/month/year) and scores notes for filename/title/tag matches.
 *
 * Lets /search handle "4到5月的筆記" via direct date matching against
 * note paths, instead of relying on embedding similarity for queries
 * that carry no topical signal.
 */

const path = require('path');

const STOPWORDS = ['的', '了', '呢', '嗎', '吧', '啊', '筆記', 'notes', 'note', '相關', '有關', '關於', '哪些', '什麼', '查', '找'];

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function addMonths(date, n) {
  return new Date(date.getFullYear(), date.getMonth() + n, 1);
}

function monthRange(year, month) {
  // month: 1-12 (JS Date normalizes overflow, e.g. month 13 -> next Jan)
  return { start: new Date(year, month - 1, 1), end: new Date(year, month, 1) };
}

function yearRange(year) {
  return { start: new Date(year, 0, 1), end: new Date(year + 1, 0, 1) };
}

function mondayOfWeek(date) {
  const d = startOfDay(date);
  const day = (d.getDay() + 6) % 7; // Mon=0..Sun=6
  return addDays(d, -day);
}

function weekRange(monday) {
  return { start: monday, end: addDays(monday, 7) };
}

// ISO 8601: week 1 is the week containing Jan 4th
function isoWeekToRange(isoYear, week) {
  const week1Monday = mondayOfWeek(new Date(isoYear, 0, 4));
  return weekRange(addDays(week1Monday, (week - 1) * 7));
}

function rangesOverlap(a, b) {
  return a.start < b.end && b.start < a.end;
}

/**
 * Extract date hints from a search query.
 * Returns the matched date ranges plus the query text with those
 * expressions removed (for lexical/semantic matching of what's left).
 */
function parseDateHints(query, now = new Date()) {
  const ranges = [];
  let text = query;

  // YYYY-MM-DD / YYYY/MM/DD / YYYY年MM月DD日
  text = text.replace(/(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?/g, (_, y, m, d) => {
    const start = new Date(+y, +m - 1, +d);
    ranges.push({ start, end: addDays(start, 1) });
    return ' ';
  });

  // Month range, optional leading year: "4到5月" / "2026年4到5月" / "4月到5月"
  text = text.replace(/(?:(\d{4})年)?(\d{1,2})\s*月?\s*[~到至-]\s*(\d{1,2})\s*月/g, (_, y, m1, m2) => {
    const startMonth = +m1;
    const endMonth = +m2;
    const year = y ? +y : now.getFullYear();
    const endYear = endMonth < startMonth ? year + 1 : year;
    ranges.push({ start: monthRange(year, startMonth).start, end: monthRange(endYear, endMonth).end });
    return ' ';
  });

  // YYYY-MM / YYYY年MM月
  text = text.replace(/(\d{4})[-/年](\d{1,2})月?(?!\d)/g, (_, y, m) => {
    ranges.push(monthRange(+y, +m));
    return ' ';
  });

  // Standalone year: "2026年"
  text = text.replace(/(\d{4})年/g, (_, y) => {
    ranges.push(yearRange(+y));
    return ' ';
  });

  // Month only: "5月" — assume current year, or last year if that month hasn't happened yet
  text = text.replace(/(\d{1,2})\s*月/g, (_, m) => {
    const month = +m;
    const year = month > now.getMonth() + 1 ? now.getFullYear() - 1 : now.getFullYear();
    ranges.push(monthRange(year, month));
    return ' ';
  });

  // Relative day (longest-first so "前天"/"昨天" aren't shadowed by "今天")
  text = text.replace(/前天/g, () => {
    const d = addDays(startOfDay(now), -2);
    ranges.push({ start: d, end: addDays(d, 1) });
    return ' ';
  });
  text = text.replace(/昨天/g, () => {
    const d = addDays(startOfDay(now), -1);
    ranges.push({ start: d, end: addDays(d, 1) });
    return ' ';
  });
  text = text.replace(/今[天日]/g, () => {
    const d = startOfDay(now);
    ranges.push({ start: d, end: addDays(d, 1) });
    return ' ';
  });

  // Relative week (ISO, Monday-start) — "上上週" before "上週" before "這週/本週"
  text = text.replace(/上上[週周]/g, () => {
    ranges.push(weekRange(addDays(mondayOfWeek(now), -14)));
    return ' ';
  });
  text = text.replace(/上[週周]/g, () => {
    ranges.push(weekRange(addDays(mondayOfWeek(now), -7)));
    return ' ';
  });
  text = text.replace(/[這本][週周]/g, () => {
    ranges.push(weekRange(mondayOfWeek(now)));
    return ' ';
  });

  // Relative month
  text = text.replace(/上個?月/g, () => {
    const prev = addMonths(now, -1);
    ranges.push(monthRange(prev.getFullYear(), prev.getMonth() + 1));
    return ' ';
  });
  text = text.replace(/[這本]個?月/g, () => {
    ranges.push(monthRange(now.getFullYear(), now.getMonth() + 1));
    return ' ';
  });

  // Relative year — "前年" before "去年" before "今年"
  text = text.replace(/前年/g, () => {
    ranges.push(yearRange(now.getFullYear() - 2));
    return ' ';
  });
  text = text.replace(/去年/g, () => {
    ranges.push(yearRange(now.getFullYear() - 1));
    return ' ';
  });
  text = text.replace(/今年/g, () => {
    ranges.push(yearRange(now.getFullYear()));
    return ' ';
  });

  // "最近" — last 14 days
  text = text.replace(/最近/g, () => {
    const today = startOfDay(now);
    ranges.push({ start: addDays(today, -14), end: addDays(today, 1) });
    return ' ';
  });

  return { ranges, cleanedQuery: text.replace(/\s+/g, ' ').trim() };
}

/**
 * Derive a date range from a note's relative path, based on the
 * filename conventions used under memory/ (daily notes, weekly
 * reviews, monthly summaries). Returns null if no date pattern found.
 */
function extractNoteDate(relPath) {
  let m = relPath.match(/(\d{4})-W(\d{2})/i);
  if (m) return isoWeekToRange(+m[1], +m[2]);

  m = relPath.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) {
    const start = new Date(+m[1], +m[2] - 1, +m[3]);
    return { start, end: addDays(start, 1) };
  }

  m = relPath.match(/(\d{4})-(\d{2})(?!-)/);
  if (m) return monthRange(+m[1], +m[2]);

  return null;
}

function noteMatchesDate(relPath, queryRanges) {
  if (!queryRanges.length) return false;
  const noteRange = extractNoteDate(relPath);
  if (!noteRange) return false;
  return queryRanges.some(r => rangesOverlap(r, noteRange));
}

/**
 * Score a note for direct filename/title/tag relevance to the (cleaned)
 * query text. Returns 0 when there's nothing left to match against.
 */
function lexicalScore(cleanedQuery, note) {
  const q = cleanedQuery.trim().toLowerCase();
  if (!q) return 0;

  const base = path.basename(note.key, path.extname(note.key)).toLowerCase();
  const fullPath = note.key.toLowerCase();
  const title = (note.title || '').toLowerCase();

  if (base.length >= 2 && q.includes(base)) return 1;
  if (q.includes(fullPath)) return 1;
  if (title && (q.includes(title) || title.includes(q))) return 0.9;

  for (const tag of note.tags || []) {
    const t = String(tag).toLowerCase();
    if (t && (q.includes(t) || t.includes(q))) return 0.8;
  }

  return 0;
}

/**
 * True if the text carries no topical signal once filler words are
 * stripped — used to decide whether to rank date matches by topic
 * or just by recency.
 */
function isTrivialQuery(text) {
  let t = text;
  for (const w of STOPWORDS) t = t.split(w).join('');
  t = t.replace(/[\s,，。.!?！？、~-]/g, '');
  return t.length === 0;
}

module.exports = {
  parseDateHints,
  extractNoteDate,
  noteMatchesDate,
  rangesOverlap,
  lexicalScore,
  isTrivialQuery,
};
