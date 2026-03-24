/**
 * Lightweight Google Drive OAuth helper.
 *
 * Handles the authorization handshake only — actual Drive API calls
 * are handled by the google-drive MCP server (@piotr-agier/google-drive-mcp).
 *
 * Flow:
 *   1. /drive-connect → getAuthUrl(wsRel) → send Google OAuth URL to user
 *   2. User authorizes → Google redirects to /drive-auth/callback
 *   3. handleCallback(code, state) → exchanges code → saves tokens → updates .mcp.json
 *
 * Requires:
 *   GDRIVE_OAUTH_KEYS_PATH — path to gcp-oauth.keys.json (Web application type)
 *   WEB_PUBLIC_URL         — public URL of this server (for redirect URI)
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const wm = require('./workspace-manager');
const { createLogger } = require('./logger');

const log = createLogger('drive-auth', {
  logDir: process.env.LOG_DIR || path.join(__dirname, '..', '..', 'logs'),
});

const TOKEN_FILE = '.gdrive/tokens.json';
const MCP_SERVER_KEY = 'google-drive';
const MCP_SERVER_PACKAGE = '@piotr-agier/google-drive-mcp';

// --- Helpers ---

function loadKeys() {
  const keysPath = process.env.GDRIVE_OAUTH_KEYS_PATH;
  if (!keysPath) throw new Error('GDRIVE_OAUTH_KEYS_PATH not set in .env');
  const raw = JSON.parse(fs.readFileSync(keysPath, 'utf-8'));
  // gcp-oauth.keys.json format: { web: { client_id, client_secret, redirect_uris } }
  const keys = raw.web || raw.installed;
  if (!keys) throw new Error('Invalid gcp-oauth.keys.json format (expected "web" or "installed" key)');
  return keys;
}

function getRedirectUri() {
  const publicUrl = (process.env.WEB_PUBLIC_URL || '').replace(/\/$/, '');
  if (!publicUrl) throw new Error('WEB_PUBLIC_URL must be set in .env for Drive OAuth callback');
  return `${publicUrl}/drive-auth/callback`;
}

// --- Public API ---

/** Whether Google Drive OAuth is configured server-wide. */
function isConfigured() {
  if (!process.env.GDRIVE_OAUTH_KEYS_PATH || !process.env.WEB_PUBLIC_URL) return false;
  try { loadKeys(); return true; } catch { return false; }
}

/** Whether this workspace has completed Drive OAuth. */
function isConnected(wsAbsPath) {
  const tokenPath = path.join(wsAbsPath, TOKEN_FILE);
  try {
    const tokens = JSON.parse(fs.readFileSync(tokenPath, 'utf-8'));
    return !!(tokens && tokens.access_token);
  } catch { return false; }
}

/** Generate Google OAuth URL. wsRel is encoded in the state parameter. */
function getAuthUrl(wsRel) {
  const keys = loadKeys();
  const params = new URLSearchParams({
    client_id: keys.client_id,
    redirect_uri: getRedirectUri(),
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/drive.file',
    access_type: 'offline',
    prompt: 'consent',
    state: Buffer.from(wsRel).toString('base64url'),
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

/** Exchange auth code for tokens (plain HTTPS, no extra dependencies). */
function exchangeCode(code) {
  const keys = loadKeys();
  const body = new URLSearchParams({
    code,
    client_id: keys.client_id,
    client_secret: keys.client_secret,
    redirect_uri: getRedirectUri(),
    grant_type: 'authorization_code',
  }).toString();

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'oauth2.googleapis.com',
      path: '/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) reject(new Error(parsed.error_description || parsed.error));
          else resolve(parsed);
        } catch { reject(new Error('Failed to parse token response')); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Handle Google OAuth callback.
 * Exchanges code for tokens, saves to workspace, updates .mcp.json.
 * Returns wsRel of the connected workspace.
 */
async function handleCallback(code, state) {
  const wsRel = Buffer.from(state, 'base64url').toString('utf-8');
  const wsAbsPath = path.join(wm.DATA_DIR, wsRel);

  if (!wsAbsPath.startsWith(wm.DATA_DIR + path.sep)) {
    throw new Error('Invalid workspace path in state');
  }

  const tokens = await exchangeCode(code);

  // Save tokens to workspace
  const tokenAbsPath = path.join(wsAbsPath, TOKEN_FILE);
  fs.mkdirSync(path.dirname(tokenAbsPath), { recursive: true });
  fs.writeFileSync(tokenAbsPath, JSON.stringify(tokens, null, 2));

  // Update workspace .mcp.json to include the google-drive MCP server
  const mcpPath = path.join(wsAbsPath, '.mcp.json');
  let mcp = { mcpServers: {} };
  try { mcp = JSON.parse(fs.readFileSync(mcpPath, 'utf-8')); } catch {}
  if (!mcp.mcpServers) mcp.mcpServers = {};

  mcp.mcpServers[MCP_SERVER_KEY] = {
    command: 'npx',
    args: ['-y', MCP_SERVER_PACKAGE],
    env: {
      GOOGLE_DRIVE_OAUTH_CREDENTIALS: process.env.GDRIVE_OAUTH_KEYS_PATH,
      GOOGLE_DRIVE_MCP_TOKEN_PATH: tokenAbsPath,
    },
  };

  fs.writeFileSync(mcpPath, JSON.stringify(mcp, null, 2));
  log.info(`Drive connected for ${wsRel}`);
  return wsRel;
}

module.exports = { isConfigured, isConnected, getAuthUrl, handleCallback };
