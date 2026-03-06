const FENCE_CLOSE = '\n```';
const MAX_FENCE_OPEN = 20;
const FENCE_RESERVE = FENCE_CLOSE.length;

/**
 * Detect the open code fence (``` or ```lang) state at a given position.
 * Returns the fence line (e.g. "```js") if inside a code block, or null.
 */
function openFenceAt(text) {
  let inFence = null;
  const lines = text.split('\n');
  for (const line of lines) {
    const match = line.match(/^(`{3,})(.*)/);
    if (match) {
      if (!inFence) {
        inFence = match[1] + match[2].trim();
      } else {
        inFence = null;
      }
    }
  }
  return inFence;
}

/**
 * Find a good split point within text, preferring newlines then spaces.
 */
function findSplitPoint(text, limit) {
  if (text.length <= limit) return text.length;

  const searchRange = text.slice(0, limit);

  const lastNewline = searchRange.lastIndexOf('\n');
  if (lastNewline > limit * 0.3) return lastNewline + 1;

  const lastSpace = searchRange.lastIndexOf(' ');
  if (lastSpace > limit * 0.3) return lastSpace + 1;

  return limit;
}

/**
 * Split a message into chunks that fit a given character limit.
 * Preserves code fence (```) continuity across chunks.
 *
 * @param {string} text - The text to split
 * @param {object} [options]
 * @param {number} [options.maxLength=2000] - Max characters per chunk
 * @param {boolean} [options.preserveCodeFences=true] - Carry code fences across chunks
 * @returns {string[]}
 */
function splitMessage(text, { maxLength = 2000, preserveCodeFences = true } = {}) {
  if (text.length <= maxLength) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    const limit = maxLength - FENCE_RESERVE;
    const splitAt = findSplitPoint(remaining, limit);

    let chunk = remaining.slice(0, splitAt);
    remaining = remaining.slice(splitAt);

    if (preserveCodeFences) {
      const fence = openFenceAt(chunk);
      if (fence) {
        chunk += FENCE_CLOSE;
        remaining = fence + '\n' + remaining;
      }
    }

    chunks.push(chunk);
  }

  return chunks;
}

module.exports = { splitMessage, openFenceAt, findSplitPoint };
