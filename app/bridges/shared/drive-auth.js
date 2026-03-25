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

// --- Sync ---

const EXCLUDED_DIRS = new Set(['.gdrive', 'uploads', 'outbox', 'node_modules']);
const EXCLUDED_FILES = new Set([
  'CLAUDE.md', 'BOOTSTRAP.md', 'jobs.json', 'profile.json',
  'preferences.json', 'session-store.jsonl', 'talk-history.jsonl',
]);
const MAX_FILE_SIZE = 50 * 1024 * 1024;

function guessMimeType(name) {
  const ext = path.extname(name).toLowerCase();
  return { '.md': 'text/markdown', '.txt': 'text/plain', '.json': 'application/json',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.pdf': 'application/pdf' }[ext] || 'application/octet-stream';
}

function collectFiles(wsAbsPath) {
  const files = [];
  function walk(dir, relPrefix) {
    let entries; try { entries = fs.readdirSync(dir); } catch { return; }
    for (const name of entries) {
      if (name.startsWith('.') || EXCLUDED_FILES.has(name)) continue;
      const abs = path.join(dir, name);
      const rel = relPrefix ? `${relPrefix}/${name}` : name;
      let stat; try { stat = fs.statSync(abs); } catch { continue; }
      if (stat.isDirectory()) { if (!EXCLUDED_DIRS.has(name)) walk(abs, rel); }
      else if (stat.isFile() && stat.size <= MAX_FILE_SIZE) files.push({ abs, rel, name });
    }
  }
  walk(wsAbsPath, '');
  return files;
}

/** Refresh access token if expired. Returns valid access_token string. */
async function getValidAccessToken(wsAbsPath) {
  const tokenPath = path.join(wsAbsPath, TOKEN_FILE);
  let tokens = JSON.parse(fs.readFileSync(tokenPath, 'utf-8'));

  // Refresh if expired (with 60s buffer)
  if (tokens.expiry_date && Date.now() > tokens.expiry_date - 60000) {
    const keys = loadKeys();
    const body = new URLSearchParams({
      client_id: keys.client_id,
      client_secret: keys.client_secret,
      refresh_token: tokens.refresh_token,
      grant_type: 'refresh_token',
    }).toString();

    const fresh = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
      }, (res) => {
        let data = ''; res.on('data', c => { data += c; });
        res.on('end', () => { try { const p = JSON.parse(data); p.error ? reject(new Error(p.error_description || p.error)) : resolve(p); } catch { reject(new Error('Token refresh parse error')); } });
      });
      req.on('error', reject); req.write(body); req.end();
    });

    tokens = { ...tokens, ...fresh, expiry_date: Date.now() + fresh.expires_in * 1000 };
    fs.writeFileSync(tokenPath, JSON.stringify(tokens, null, 2));
  }

  return tokens.access_token;
}

/** Drive REST API call (returns parsed JSON). */
function driveApi(method, endpoint, accessToken, body, contentType) {
  return new Promise((resolve, reject) => {
    const bodyBuf = body ? (typeof body === 'string' ? Buffer.from(body) : body) : null;
    const req = https.request({
      hostname: 'www.googleapis.com', path: endpoint, method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(contentType && bodyBuf ? { 'Content-Type': contentType, 'Content-Length': bodyBuf.length } : {}),
      },
    }, (res) => {
      let data = ''; res.on('data', c => { data += c; });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(data); } });
    });
    req.on('error', reject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

/** Upload a file via Drive multipart upload. */
async function uploadFile(accessToken, name, mimeType, parentId, fileId, content) {
  const boundary = '----SynapsisBoundary';
  const meta = JSON.stringify({ name, ...(fileId ? {} : { parents: [parentId] }) });
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json\r\n\r\n${meta}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`),
    content,
    Buffer.from(`\r\n--${boundary}--`),
  ]);

  const method = fileId ? 'PATCH' : 'POST';
  const endpoint = fileId
    ? `/upload/drive/v3/files/${fileId}?uploadType=multipart`
    : '/upload/drive/v3/files?uploadType=multipart&fields=id';

  return driveApi(method, endpoint, accessToken, body, `multipart/related; boundary=${boundary}`);
}

/** Ensure a Drive folder exists, return its id. */
async function ensureFolder(accessToken, name, parentId) {
  const q = encodeURIComponent(`name='${name.replace(/'/g, "\\'")}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`);
  const res = await driveApi('GET', `/drive/v3/files?q=${q}&fields=files(id)`, accessToken);
  if (res.files && res.files.length > 0) return res.files[0].id;
  const r = await driveApi('POST', '/drive/v3/files?fields=id', accessToken,
    JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] }), 'application/json');
  return r.id;
}

const MANIFEST_FILE = '.gdrive/manifest.json';

/** List all non-folder files in a Drive folder recursively. Returns [{ id, rel, name, modifiedTime }] */
async function listDriveFiles(accessToken, folderId, relPrefix) {
  const results = [];
  let pageToken = '';
  do {
    const q = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
    const endpoint = `/drive/v3/files?q=${q}&fields=nextPageToken,files(id,name,mimeType,modifiedTime)${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
    const res = await driveApi('GET', endpoint, accessToken);
    for (const f of (res.files || [])) {
      const rel = relPrefix ? `${relPrefix}/${f.name}` : f.name;
      if (f.mimeType === 'application/vnd.google-apps.folder') {
        results.push(...await listDriveFiles(accessToken, f.id, rel));
      } else {
        results.push({ id: f.id, rel, name: f.name, modifiedTime: f.modifiedTime });
      }
    }
    pageToken = res.nextPageToken || '';
  } while (pageToken);
  return results;
}

/** Download a Drive file, return Buffer. */
function downloadDriveFile(accessToken, fileId) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'www.googleapis.com',
      path: `/drive/v3/files/${fileId}?alt=media`,
      headers: { Authorization: `Bearer ${accessToken}` },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * Bidirectional sync between workspace and Google Drive (no AI, no token burn).
 * - Upload: local files → Drive (only if local is newer or Drive doesn't have it)
 * - Download: Drive files → local (only if Drive is newer or not present locally)
 * Returns { uploaded, downloaded, total, errors }.
 */
async function syncToDrive(wsAbsPath) {
  if (!isConnected(wsAbsPath)) throw new Error('Google Drive not connected. Use /drive-connect first.');

  const accessToken = await getValidAccessToken(wsAbsPath);
  const manifestPath = path.join(wsAbsPath, MANIFEST_FILE);
  let manifest = { rootFolderId: null, files: {}, dirs: {} };
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')); } catch {}

  // Ensure root folder
  if (!manifest.rootFolderId) {
    manifest.rootFolderId = await ensureFolder(accessToken, DRIVE_FOLDER_NAME, 'root');
  }

  const folderCache = { '': manifest.rootFolderId };
  const localFiles = collectFiles(wsAbsPath);
  const localRelSet = new Set(localFiles.map(f => f.rel));
  let uploaded = 0, downloaded = 0;
  const errors = [];

  // Pre-fetch all Drive files for timestamp comparison
  const driveFileMap = {}; // rel → { id, modifiedTime }
  try {
    const driveFiles = await listDriveFiles(accessToken, manifest.rootFolderId, '');
    for (const df of driveFiles) driveFileMap[df.rel] = df;
  } catch (err) {
    log.warn(`Drive listing failed: ${err.message}`);
  }

  // --- Phase 1: Upload local → Drive (skip if Drive is newer) ---
  for (const file of localFiles) {
    try {
      const driveFile = driveFileMap[file.rel];
      if (driveFile) {
        const localMtime = fs.statSync(file.abs).mtimeMs;
        const driveMtime = new Date(driveFile.modifiedTime).getTime();
        if (driveMtime > localMtime) continue; // Drive is newer — will be downloaded in Phase 2
      }

      const dirRel = path.dirname(file.rel) === '.' ? '' : path.dirname(file.rel);
      if (dirRel && !folderCache[dirRel]) {
        let cur = manifest.rootFolderId;
        let built = '';
        for (const part of dirRel.split('/')) {
          built = built ? `${built}/${part}` : part;
          if (folderCache[built]) { cur = folderCache[built]; continue; }
          if (manifest.dirs[built]) { folderCache[built] = manifest.dirs[built]; cur = manifest.dirs[built]; continue; }
          cur = await ensureFolder(accessToken, part, cur);
          folderCache[built] = cur; manifest.dirs[built] = cur;
        }
      }
      const parentId = folderCache[dirRel] || manifest.rootFolderId;
      const content = fs.readFileSync(file.abs);
      const res = await uploadFile(accessToken, file.name, guessMimeType(file.name), parentId, manifest.files[file.rel] || null, content);
      if (res.id) manifest.files[file.rel] = res.id;
      uploaded++;
    } catch (err) {
      log.warn(`Upload failed for ${file.rel}: ${err.message}`);
      errors.push(file.rel);
    }
  }

  // --- Phase 2: Download Drive → local (Drive-only OR Drive-newer files) ---
  for (const [rel, df] of Object.entries(driveFileMap)) {
    if (localRelSet.has(rel)) {
      // File exists locally — only download if Drive is newer
      try {
        const localAbs = path.join(wsAbsPath, rel);
        const localMtime = fs.statSync(localAbs).mtimeMs;
        const driveMtime = new Date(df.modifiedTime).getTime();
        if (driveMtime <= localMtime) continue; // local is same or newer, skip
      } catch { continue; }
    }
    try {
      const localPath = path.join(wsAbsPath, rel);
      fs.mkdirSync(path.dirname(localPath), { recursive: true });
      const content = await downloadDriveFile(accessToken, df.id);
      fs.writeFileSync(localPath, content);
      manifest.files[rel] = df.id;
      downloaded++;
    } catch (err) {
      log.warn(`Download failed for ${rel}: ${err.message}`);
      errors.push(rel);
    }
  }

  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  log.info(`Drive sync complete for ${path.basename(wsAbsPath)}: ↑${uploaded} ↓${downloaded}`);
  return { uploaded, downloaded, total: localFiles.length, errors };
}

const DRIVE_FOLDER_NAME = process.env.GDRIVE_FOLDER_NAME || 'Synapsis Notes';

module.exports = { isConfigured, isConnected, getAuthUrl, handleCallback, syncToDrive };
