/**
 * Convert markdown notes into natural-language text suitable for TTS narration.
 *
 * Strips markdown syntax that would otherwise be read aloud literally (#, **, |, etc.)
 * and converts structural elements (tables, lists, headers) into spoken sentences.
 */

function ensureSentenceEnd(text) {
  if (!text) return text;
  if (/[。！？.!?，,；;:：]$/.test(text)) return text;
  return `${text}。`;
}

function stripInline(str) {
  return str
    // Images: drop entirely (alt text is usually a filename/URL, not meant to be spoken)
    .replace(/!\[([^\]]*)\]\(([^)]*)\)/g, '')
    // Links: keep visible text only
    .replace(/\[([^\]]*)\]\(([^)]*)\)/g, '$1')
    // Inline code
    .replace(/`([^`]+)`/g, '$1')
    // Bold (before italic, to avoid ** partially matching *)
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    // Strikethrough
    .replace(/~~([^~]+)~~/g, '$1')
    // Italic
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/(?<![a-zA-Z0-9])_([^_]+)_(?![a-zA-Z0-9])/g, '$1');
}

function isTableRow(line) {
  return line.includes('|') && line.trim().length > 0;
}

function isTableSeparator(line) {
  const trimmed = line.trim();
  if (!trimmed.includes('-')) return false;
  return /^\|?[\s:|-]+\|?$/.test(trimmed);
}

function parseTableRow(line) {
  let trimmed = line.trim();
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1);
  if (trimmed.endsWith('|')) trimmed = trimmed.slice(0, -1);
  return trimmed.split('|').map((cell) => cell.trim());
}

/**
 * Detect `| col | col |` / `|---|---|` table blocks and convert each data row
 * into a spoken sentence: "header1: value1，header2: value2。"
 */
function convertTables(lines) {
  const result = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const next = lines[i + 1];

    if (isTableRow(line) && next !== undefined && isTableSeparator(next)) {
      const headers = parseTableRow(line).map((cell) => stripInline(cell));
      i += 2; // skip header + separator row

      while (i < lines.length && isTableRow(lines[i])) {
        const cells = parseTableRow(lines[i]).map((cell) => stripInline(cell));
        const sentence = headers
          .map((header, idx) => `${header}: ${cells[idx] && cells[idx].length > 0 ? cells[idx] : '無'}`)
          .join('，');
        result.push(`${sentence}。`);
        i++;
      }
      continue;
    }

    result.push(line);
    i++;
  }

  return result;
}

/**
 * Process a single non-table line: strip blockquote markers, drop horizontal rules,
 * convert headers/list items into spoken sentences, and strip inline markdown elsewhere.
 * Returns null if the line should be dropped entirely.
 */
function processLine(line) {
  const stripped = line.replace(/^(\s*>)+\s?/, '');

  // Horizontal rule: ---, ***, ___ (with optional spaces between repeated chars)
  if (/^\s*([-*_])\s*(\1\s*){2,}\s*$/.test(stripped)) {
    return null;
  }

  // Header
  let m = stripped.match(/^(#{1,6})\s+(.+)$/);
  if (m) {
    return ensureSentenceEnd(stripInline(m[2].trim()));
  }

  // Task list item: - [ ] / - [x]
  m = stripped.match(/^\s*[-*+]\s+\[[ xX]\]\s+(.+)$/);
  if (m) {
    return ensureSentenceEnd(stripInline(m[1].trim()));
  }

  // Unordered list item
  m = stripped.match(/^\s*[-*+]\s+(.+)$/);
  if (m) {
    return ensureSentenceEnd(stripInline(m[1].trim()));
  }

  // Ordered list item
  m = stripped.match(/^\s*\d+[.)]\s+(.+)$/);
  if (m) {
    return ensureSentenceEnd(stripInline(m[1].trim()));
  }

  return stripInline(stripped);
}

function toSpeechText(markdown) {
  if (!markdown) return '';

  let text = markdown;

  // Strip HTML comments (can span lines)
  text = text.replace(/<!--[\s\S]*?-->/g, '');

  // Strip fenced code blocks entirely, including unterminated fences
  text = text.replace(/```[\s\S]*?```/g, '');
  const fenceCount = (text.match(/```/g) || []).length;
  if (fenceCount % 2 !== 0) {
    text = text.replace(/```[\s\S]*$/, '');
  }

  let lines = text.split('\n');
  lines = convertTables(lines);

  text = lines
    .map(processLine)
    .filter((line) => line !== null)
    .join('\n');

  text = text.replace(/\n{3,}/g, '\n\n');
  text = text.replace(/[ \t]+$/gm, '');
  text = text.trim();

  return text;
}

module.exports = { toSpeechText };
