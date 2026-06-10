const SENTENCE_SPLIT_RE = /(?<=[。！？.!?\n])/;
const PARAGRAPH_SPLIT_RE = /\n{2,}/;

/**
 * Split text into chunks no larger than the given size limit, preferring to break
 * on paragraph boundaries, then sentence boundaries, then hard character splits.
 *
 * @param {string} text
 * @param {{ maxBytes?: number, maxChars?: number }} options - exactly one of maxBytes/maxChars
 * @returns {string[]}
 */
function chunkText(text, { maxBytes, maxChars } = {}) {
  const maxSize = maxBytes || maxChars;
  if (!maxSize) throw new Error('chunkText requires maxBytes or maxChars');
  const sizeOf = maxBytes ? (s) => Buffer.byteLength(s, 'utf-8') : (s) => s.length;

  const chunks = [];
  let current = '';

  function flush() {
    if (current.length > 0) chunks.push(current);
    current = '';
  }

  function addPiece(piece) {
    if (current.length === 0) {
      current = piece;
      return;
    }
    const candidate = current + piece;
    if (sizeOf(candidate) <= maxSize) {
      current = candidate;
    } else {
      flush();
      current = piece;
    }
  }

  function splitHard(piece) {
    const result = [];
    let buf = '';
    for (const ch of Array.from(piece)) {
      const candidate = buf + ch;
      if (sizeOf(candidate) <= maxSize) {
        buf = candidate;
      } else {
        if (buf.length > 0) result.push(buf);
        buf = ch;
      }
    }
    if (buf.length > 0) result.push(buf);
    return result;
  }

  function processPiece(piece) {
    if (sizeOf(piece) <= maxSize) {
      addPiece(piece);
      return;
    }

    const sentences = piece.split(SENTENCE_SPLIT_RE).filter((s) => s.length > 0);
    if (sentences.length > 1) {
      for (const sentence of sentences) processPiece(sentence);
      return;
    }

    flush();
    for (const hard of splitHard(piece)) {
      chunks.push(hard);
    }
  }

  const paragraphs = text.split(PARAGRAPH_SPLIT_RE).filter((p) => p.trim().length > 0);
  for (const paragraph of paragraphs) {
    processPiece(`${paragraph}\n\n`);
  }
  flush();

  return chunks.map((c) => c.trim()).filter((c) => c.length > 0);
}

module.exports = { chunkText };
