const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.json', '.js', '.ts', '.jsx', '.tsx', '.py', '.rb', '.go',
  '.rs', '.java', '.c', '.cpp', '.h', '.hpp', '.cs', '.sh', '.bash', '.zsh',
  '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.xml', '.html', '.css',
  '.scss', '.sql', '.graphql', '.env', '.log', '.csv', '.tsv', '.diff', '.patch',
]);

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Sanitize output before sending to users.
 *
 * - Own workspace absolute paths -> converted to relative
 * - Leaked secrets -> stripped
 * - Infrastructure paths (other workspaces, absolute paths, shard paths) -> BLOCK
 *
 * @param {string} text - Raw output
 * @param {string} [wsPath] - Absolute workspace path (used to convert to relative paths)
 * @returns {{ safe: boolean, text: string }}
 */
// Extract system username from HOME to redact from output
const _homeUser = (() => {
  const home = process.env.HOME || require('os').homedir();
  const parts = home.split('/').filter(Boolean);
  // /Users/<name> or /home/<name> — grab the leaf
  return parts.length >= 2 ? parts[parts.length - 1] : null;
})();

function sanitizeOutput(text, wsPath) {
  let result = text;

  // Convert own workspace absolute paths to relative first (before leak detection)
  if (wsPath) {
    const wsWithSlash = wsPath.endsWith('/') ? wsPath : wsPath + '/';
    result = result.replace(new RegExp(escapeRegExp(wsWithSlash), 'g'), '');
    result = result.replace(new RegExp(escapeRegExp(wsPath), 'g'), '.');
  }

  // Redact system username wherever it appears (path fragments, casual mentions)
  if (_homeUser && _homeUser.length >= 3) {
    result = result.replace(new RegExp(escapeRegExp(_homeUser), 'gi'), '[user]');
  }

  // Detect infrastructure leaks — block if found
  const leakPatterns = [
    /\/(?:Users|home|root|opt|var|etc|srv|mnt)\/\S+/,
    /[MN][A-Za-z0-9]{23,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}/,
    /(?:DISCORD_TOKEN|TOKEN)\s*=\s*\S+/i,
    /(?:SECRET|KEY|PASSWORD|CREDENTIAL)\s*=\s*\S+/i,
  ];

  for (const pattern of leakPatterns) {
    const match = result.match(pattern);
    if (match) {
      return { safe: false, text: result, blockedBy: pattern.toString(), matchedText: match[0].slice(0, 60) };
    }
  }

  return { safe: true, text: result };
}

function isTextFile(name) {
  const ext = (name.match(/\.[^.]+$/) || [''])[0].toLowerCase();
  return TEXT_EXTENSIONS.has(ext);
}

module.exports = { sanitizeOutput, isTextFile, TEXT_EXTENSIONS };
