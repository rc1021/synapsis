const { startServer, stopServer, createWebToken, log } = require('./server');

function getPublicUrl() {
  const publicUrl = process.env.WEB_PUBLIC_URL;
  if (publicUrl) return publicUrl.replace(/\/$/, '');

  const port = process.env.WEB_PORT || '3001';
  const host = process.env.WEB_PUBLIC_HOST || process.env.WEB_HOST || '0.0.0.0';
  // If bound to 0.0.0.0, use machine hostname for the URL
  const displayHost = host === '0.0.0.0' ? require('os').hostname() : host;
  return `http://${displayHost}:${port}`;
}

/**
 * Generate a web dashboard access URL for a workspace.
 * @param {string} wsRel - Workspace relative path
 * @param {string} [filePath] - Optional file path for deep linking
 */
function generateAccessUrl(wsRel, filePath) {
  const token = createWebToken(wsRel);
  let url = `${getPublicUrl()}/dash?t=${token}`;
  if (filePath) url += `&path=${encodeURIComponent(filePath)}`;
  return url;
}

/**
 * Get the public URL for the soul commons page (no auth required).
 */
function getCommonsUrl() {
  return `${getPublicUrl()}/commons`;
}

async function start() {
  if (!process.env.WEB_PORT && !process.env.WEB_ENABLED) {
    log.info('Web dashboard disabled (set WEB_PORT or WEB_ENABLED=1 to enable)');
    return;
  }
  startServer();
}

function cleanup() {
  stopServer();
}

module.exports = { name: 'web', start, cleanup, generateAccessUrl, getCommonsUrl };
