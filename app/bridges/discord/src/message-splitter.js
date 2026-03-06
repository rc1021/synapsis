const { splitMessage: sharedSplit } = require('../../shared/message-utils');

const DISCORD_LIMIT = 2000;

/**
 * Wrap bare URLs with <> to suppress Discord embeds.
 */
function suppressEmbeds(text) {
  return text.replace(/(^|[\s(])(https?:\/\/[^\s>)]+)/g, (match, prefix, url) => {
    return `${prefix}<${url}>`;
  });
}

/**
 * Split a message into chunks that fit Discord's 2000-char limit.
 * Applies suppressEmbeds before splitting.
 */
function splitMessage(text) {
  text = suppressEmbeds(text);
  return sharedSplit(text, { maxLength: DISCORD_LIMIT });
}

module.exports = { splitMessage, suppressEmbeds };
