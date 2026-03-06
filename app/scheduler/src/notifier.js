const { execFile } = require('child_process');
const path = require('path');
const log = require('./logger');
const wm = require('../../bridges/shared/workspace-manager');

const CHANNELS_DIR = path.join(__dirname, '..', '..', 'channels');

/** Wrap bare URLs with <> to suppress Discord embeds. */
function suppressEmbeds(text) {
  return text.replace(/(^|[\s(])(https?:\/\/[^\s>)]+)/g, (_, prefix, url) => `${prefix}<${url}>`);
}

// Bridge registry — populated at runtime by bridges registering themselves
const bridges = new Map(); // name -> { sendDM }

function registerBridge(name, bridge) {
  bridges.set(name, bridge);
  log.info(`Notifier: bridge "${name}" registered`);
}

function getChannelScript(via) {
  return path.join(CHANNELS_DIR, `${via}.sh`);
}

function shouldNotify(job, output, error) {
  if (!job.notify) return false;

  const { when } = job.notify;

  switch (when) {
    case 'always':
      return true;
    case 'error':
      return !!error;
    case 'not_match':
      return !output || !output.includes(job.notify.match);
    default:
      return false;
  }
}

function sendNotification(job, output, error) {
  const via = job.notify?.via || 'discord-bridge';
  const script = getChannelScript(via);

  let message;
  if (error) {
    message = `${job.name} (${job.id}) failed:\n${error}`;
  } else {
    message = output;
  }

  message = suppressEmbeds(message);
  if (message.length > 1900) {
    message = message.slice(0, 1897) + '...';
  }

  return new Promise((resolve, reject) => {
    execFile('bash', [script, message], { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) {
        log.error(`Notification failed for ${job.id} via ${via}:`, err.message);
        if (stderr) log.error(`${via} stderr:`, stderr);
        reject(err);
      } else {
        log.info(`Notification sent for ${job.id} via ${via}: ${stdout.trim()}`);
        resolve(stdout);
      }
    });
  });
}

/**
 * Send notification to all bridge accounts bound to a workspace.
 * @param {string} wsAbsPath
 * @param {object} job
 * @param {string} output
 * @param {string|null} error
 * @param {Array<{attachment: Buffer, name: string}>} [files]
 */
async function notifyAllBindings(wsAbsPath, job, output, error, files) {
  const profile = wm.readProfile(wsAbsPath);
  if (!profile || !profile.bindings) return;

  let message;
  if (error) {
    message = `${job.name || job.id} failed:\n${error}`;
  } else {
    message = output;
  }

  message = suppressEmbeds(message);
  if (message.length > 1900) {
    message = message.slice(0, 1897) + '...';
  }

  for (const binding of profile.bindings) {
    const [bridgeName, userId] = binding.split(':');
    const bridge = bridges.get(bridgeName);

    if (bridge && typeof bridge.sendDM === 'function') {
      try {
        await bridge.sendDM(userId, message, files);
      } catch (err) {
        log.warn(`Failed to notify ${binding}: ${err.message}`);
      }
    } else {
      log.debug(`No bridge registered for ${bridgeName}, skipping notification to ${binding}`);
    }
  }
}

module.exports = { shouldNotify, sendNotification, notifyAllBindings, registerBridge };
