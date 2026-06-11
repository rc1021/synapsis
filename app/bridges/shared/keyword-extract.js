/**
 * Lightweight keyword extraction for /list — surfaces recurring terms
 * across a set of file/folder names without any NLP dependency.
 *
 * Chinese filenames typically have no delimiters (e.g. "下雨天心情.md",
 * "下雨筆記.md"), so plain delimiter-splitting wouldn't notice they share
 * "下雨". Instead, CJK runs are broken into character bigrams and ASCII
 * runs are kept as whole words; terms appearing in 2+ distinct names are
 * ranked by how many names they appear in.
 */

const path = require('path');

// Strip date-like fragments (longest patterns first) so dates don't dominate
const DATE_PATTERN = /\d{4}-W\d{2}|\d{4}-\d{2}-\d{2}|\d{4}-\d{2}|\d{4}/gi;

/**
 * @param {string[]} names - file/folder names (basenames, not full paths)
 * @param {number} topN
 * @returns {Array<{ term: string, count: number }>}
 */
function extractKeywords(names, topN = 8) {
  const docFreq = new Map(); // term -> Set of name indices

  names.forEach((name, idx) => {
    const base = path.basename(name, path.extname(name)).replace(DATE_PATTERN, ' ');
    const terms = new Set();

    for (const word of base.match(/[a-zA-Z][a-zA-Z0-9]*/g) || []) {
      if (word.length >= 2) terms.add(word.toLowerCase());
    }

    for (const segment of base.match(/[一-鿿]+/g) || []) {
      for (let i = 0; i < segment.length - 1; i++) {
        terms.add(segment.slice(i, i + 2));
      }
    }

    for (const term of terms) {
      if (!docFreq.has(term)) docFreq.set(term, new Set());
      docFreq.get(term).add(idx);
    }
  });

  return [...docFreq.entries()]
    .filter(([, idxSet]) => idxSet.size >= 2)
    .sort((a, b) => b[1].size - a[1].size)
    .slice(0, topN)
    .map(([term, idxSet]) => ({ term, count: idxSet.size }));
}

module.exports = { extractKeywords };
