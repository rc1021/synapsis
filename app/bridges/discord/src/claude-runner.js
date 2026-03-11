/**
 * Discord bridge — thin wrapper around shared runner.
 * Provides Discord-specific system prompt rules and delegates everything else.
 */
const { enqueue: sharedEnqueue } = require('../../shared/runner');

const DISCORD_RULES = [
  'You are responding via Discord.',
  'Keep responses concise. Use Discord-compatible markdown (no tables — use bullet lists).',
  'Wrap URLs in <> to suppress embeds.',
  'IMPORTANT: To keep session context lean, delegate heavy work to the Agent tool.',
  'For requests needing file reading, code search, writing, or multi-step operations — use Agent tool in an isolated sub-agent context.',
  'Simple Q&A and conversational replies — answer directly without Agent tool.',
  'FILE ATTACHMENTS: To send files to the user, write them to the outbox/ directory. All files in outbox/ will be attached to your reply and then deleted. Use this for generated images, exports, reports, code files the user asked for, etc.',
];

/**
 * Enqueue a prompt for the Discord bridge.
 *
 * @param {string} prompt
 * @param {string} sessionId
 * @param {boolean} isResume
 * @param {function} onProgress
 * @param {string} wsPath - Workspace path (cwd)
 * @param {string} [model] - Optional model override (from tier classifier)
 * @returns {Promise<import('../../shared/runner').RunnerResult>}
 */
function enqueue(prompt, sessionId, isResume, onProgress, wsPath, model) {
  return sharedEnqueue({
    prompt,
    sessionId,
    isResume,
    onProgress,
    cwd: wsPath,
    channelRules: DISCORD_RULES,
    verbose: true,
    ...(model && { model }),
  });
}

module.exports = { enqueue, DISCORD_RULES };
