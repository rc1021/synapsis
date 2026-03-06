/**
 * Backward-compatibility shim.
 * Delegates to providers/claude-cli.js for any code still importing this module.
 */
const { cleanEnv, buildCliArgs, spawnProcess, CLAUDE_PATH } = require('./providers/claude-cli');

function buildArgs(options) {
  return buildCliArgs(options);
}

function spawnClaude({ args, cwd, sandbox = false, onStdout, onStderr }) {
  const child = spawnProcess(args, cwd, sandbox);
  if (onStdout) child.stdout.on('data', onStdout);
  if (onStderr) child.stderr.on('data', onStderr);
  return { child };
}

module.exports = { cleanEnv, buildArgs, spawnClaude, CLAUDE_PATH };
