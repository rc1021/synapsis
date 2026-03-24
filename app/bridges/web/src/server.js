const http = require('http');
const fs = require('fs');
const path = require('path');
const { createLogger } = require('../../shared/logger');
const auth = require('./auth');
const driveAuth = require('../../shared/drive-auth');

const log = createLogger('web', {
  logDir: process.env.LOG_DIR || path.join(__dirname, '..', '..', '..', 'logs'),
});

const STATIC_DIR = path.join(__dirname, 'static');
const MAX_UPLOAD_SIZE = 10 * 1024 * 1024; // 10MB

// Files/dirs users should not access
const BLOCKED_FILES = new Set([
  'profile.json',
  'jobs.json',
  'talk-history.jsonl',
  'CLAUDE.md',
  'BOOTSTRAP.md',
  'preferences.json',
]);

const BLOCKED_EXTENSIONS = new Set(['.new']);
const HIDDEN_PATTERNS = [/^\./, /^node_modules$/]; // dotfiles (.DS_Store etc), node_modules

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
};

const PROJECT_DIR = process.env.PROJECT_DIR || path.resolve(path.join(__dirname, '..', '..', '..'));
const SOUL_NETWORK_DIR = path.join(PROJECT_DIR, 'soul-network');
const STANDALONE_SOULS_FILE = path.join(PROJECT_DIR, 'app', 'standalone-souls', 'souls.json');

let server = null;

// --- Helpers ---

function send(res, status, body, contentType = 'application/json; charset=utf-8') {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

function sendFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME_TYPES[ext] || 'application/octet-stream';
  const stat = fs.statSync(filePath);
  const basename = path.basename(filePath);
  const encodedName = encodeURIComponent(basename);

  res.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': stat.size,
    'Content-Disposition': `inline; filename*=UTF-8''${encodedName}`,
  });
  fs.createReadStream(filePath).pipe(res);
}

function parseUrl(rawUrl) {
  const url = new URL(rawUrl, 'http://localhost');
  return { pathname: url.pathname, params: url.searchParams };
}

/**
 * Validate a user-supplied path is within the workspace.
 * Returns absolute path or null if invalid.
 */
function safePath(wsAbsPath, userPath) {
  if (!userPath) return wsAbsPath;

  // Reject obvious traversal
  const cleaned = userPath.replace(/\\/g, '/');
  const resolved = path.resolve(wsAbsPath, cleaned);

  if (!resolved.startsWith(wsAbsPath + path.sep) && resolved !== wsAbsPath) {
    return null;
  }

  // Check blocked files
  const basename = path.basename(resolved);
  if (BLOCKED_FILES.has(basename)) return null;

  const ext = path.extname(basename);
  if (BLOCKED_EXTENSIONS.has(ext)) return null;

  return resolved;
}

function readBody(req, maxSize) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxSize) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// --- Route handlers ---

// Bot/crawler user-agent patterns (Discord, Slack, Telegram, Twitter, etc.)
const BOT_UA_PATTERN = /bot|crawler|spider|preview|fetch|curl|wget|facebookexternalhit|twitterbot|slackbot|discordbot|telegrambot|whatsapp|embedly|quora|pinterest|redditbot|applebot/i;

function isBotRequest(req) {
  const ua = req.headers['user-agent'] || '';
  return BOT_UA_PATTERN.test(ua);
}

function handleDash(req, res, params) {
  const token = params.get('t');
  if (!token) {
    send(res, 400, { error: 'Missing token' });
    return;
  }

  // Ignore bot/crawler requests (e.g. Discord link preview) — don't consume the token
  if (isBotRequest(req)) {
    log.info(`Bot request ignored for /dash (UA: ${(req.headers['user-agent'] || '').slice(0, 80)})`);
    send(res, 200, '<html><head><meta property="og:title" content="Synapsis Dashboard"><meta property="og:description" content="Open this link to access your workspace."></head><body></body></html>', 'text/html; charset=utf-8');
    return;
  }

  const tokenData = auth.consumeWebToken(token);
  if (!tokenData) {
    send(res, 401, '<html><body><h2>Link expired or invalid</h2><p>Ask your AI companion for a new link.</p></body></html>', 'text/html; charset=utf-8');
    return;
  }

  const sessionId = auth.createSession(tokenData.wsRel);
  log.info(`Web session created for workspace ${tokenData.wsRel}`);

  // Support deep link: /dash?t=xxx&path=some/file.md
  const filePath = params.get('path');
  const location = filePath ? `/#${encodeURIComponent(filePath)}` : '/';

  res.writeHead(302, {
    'Set-Cookie': auth.sessionCookie(sessionId),
    'Location': location,
  });
  res.end();
}

function requireSession(req) {
  const cookies = auth.parseCookies(req.headers.cookie);
  return auth.getSession(cookies.sid);
}

function handleListFiles(req, res, params) {
  const session = requireSession(req);
  if (!session) return send(res, 401, { error: 'Unauthorized' });

  const userPath = params.get('path') || '';
  const absPath = safePath(session.wsAbsPath, userPath);
  if (!absPath) return send(res, 403, { error: 'Access denied' });

  try {
    const stat = fs.statSync(absPath);
    if (!stat.isDirectory()) {
      return send(res, 400, { error: 'Not a directory' });
    }

    const entries = [];
    for (const name of fs.readdirSync(absPath)) {
      // Filter blocked/hidden files
      if (BLOCKED_FILES.has(name)) continue;
      if (BLOCKED_EXTENSIONS.has(path.extname(name))) continue;
      if (HIDDEN_PATTERNS.some(p => p.test(name))) continue;

      const entryPath = path.join(absPath, name);
      try {
        const entryStat = fs.statSync(entryPath);
        entries.push({
          name,
          type: entryStat.isDirectory() ? 'dir' : 'file',
          size: entryStat.isFile() ? entryStat.size : undefined,
          modified: entryStat.mtime.toISOString(),
        });
      } catch {}
    }

    // Sort: dirs first, then alphabetical
    entries.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    send(res, 200, { path: userPath || '/', entries });
  } catch (err) {
    if (err.code === 'ENOENT') return send(res, 404, { error: 'Not found' });
    log.error(`List files error: ${err.message}`);
    send(res, 500, { error: 'Server error' });
  }
}

function handleGetFile(req, res, params) {
  const session = requireSession(req);
  if (!session) return send(res, 401, { error: 'Unauthorized' });

  const userPath = params.get('path');
  if (!userPath) return send(res, 400, { error: 'Missing path' });

  const absPath = safePath(session.wsAbsPath, userPath);
  if (!absPath) return send(res, 403, { error: 'Access denied' });

  try {
    const stat = fs.statSync(absPath);
    if (!stat.isFile()) return send(res, 400, { error: 'Not a file' });
    sendFile(res, absPath);
  } catch (err) {
    if (err.code === 'ENOENT') return send(res, 404, { error: 'Not found' });
    log.error(`Get file error: ${err.message}`);
    send(res, 500, { error: 'Server error' });
  }
}

async function handleUpload(req, res, params) {
  const session = requireSession(req);
  if (!session) return send(res, 401, { error: 'Unauthorized' });

  const userPath = params.get('path') || '';
  const fileName = params.get('name');
  if (!fileName) return send(res, 400, { error: 'Missing name' });

  // Sanitize filename
  const safeName = path.basename(fileName).replace(/[^a-zA-Z0-9._\-\u4e00-\u9fff]/g, '_');
  if (!safeName || safeName.startsWith('.')) {
    return send(res, 400, { error: 'Invalid filename' });
  }

  const dirPath = safePath(session.wsAbsPath, userPath);
  if (!dirPath) return send(res, 403, { error: 'Access denied' });

  const filePath = path.join(dirPath, safeName);
  // Re-check the final path is still inside workspace
  if (!filePath.startsWith(session.wsAbsPath + path.sep)) {
    return send(res, 403, { error: 'Access denied' });
  }

  try {
    const body = await readBody(req, MAX_UPLOAD_SIZE);
    fs.mkdirSync(dirPath, { recursive: true });
    fs.writeFileSync(filePath, body);
    log.info(`File uploaded: ${filePath} (${body.length} bytes)`);
    send(res, 200, { ok: true, name: safeName, size: body.length });
  } catch (err) {
    if (err.message === 'Body too large') {
      return send(res, 413, { error: 'File too large (max 10MB)' });
    }
    log.error(`Upload error: ${err.message}`);
    send(res, 500, { error: 'Server error' });
  }
}

function handleDelete(req, res, params) {
  const session = requireSession(req);
  if (!session) return send(res, 401, { error: 'Unauthorized' });

  const userPath = params.get('path');
  if (!userPath) return send(res, 400, { error: 'Missing path' });

  const absPath = safePath(session.wsAbsPath, userPath);
  if (!absPath) return send(res, 403, { error: 'Access denied' });

  // Don't allow deleting workspace root or critical files
  if (absPath === session.wsAbsPath) {
    return send(res, 403, { error: 'Cannot delete workspace root' });
  }

  try {
    const stat = fs.statSync(absPath);
    if (stat.isDirectory()) {
      fs.rmSync(absPath, { recursive: true });
    } else {
      fs.unlinkSync(absPath);
    }
    log.info(`File deleted: ${absPath}`);
    send(res, 200, { ok: true });
  } catch (err) {
    if (err.code === 'ENOENT') return send(res, 404, { error: 'Not found' });
    log.error(`Delete error: ${err.message}`);
    send(res, 500, { error: 'Server error' });
  }
}

/**
 * Parse a commons post file.
 * Returns { postedAt, tags, content } or null if invalid.
 */
function parseCommonsPost(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const headerMatch = raw.match(/^<!--\s*posted:\s*([^|]+)\|?\s*tags?:\s*([^-]+?)\s*-->/);
    if (!headerMatch) return null;
    const postedAt = headerMatch[1].trim();
    const tags = headerMatch[2].split(',').map(t => t.trim()).filter(Boolean);
    const content = raw.replace(/^<!--[\s\S]*?-->/, '').trim();
    return { postedAt, tags, content };
  } catch {
    return null;
  }
}

/**
 * Load standalone soul name map: { soulId -> name }
 */
function loadSoulNames() {
  try {
    const data = JSON.parse(fs.readFileSync(STANDALONE_SOULS_FILE, 'utf-8'));
    const map = {};
    for (const soul of (data.souls || [])) {
      map[soul.id] = soul.name;
    }
    return map;
  } catch {
    return {};
  }
}

function handleCommonsAPI(req, res) {
  try {
    if (!fs.existsSync(SOUL_NETWORK_DIR)) {
      return send(res, 200, { posts: [], total: 0 });
    }

    const soulNames = loadSoulNames();
    const posts = [];

    // Scan all soul directories for inbox — actually scan commons/
    const commonsDir = path.join(SOUL_NETWORK_DIR, 'commons');
    if (!fs.existsSync(commonsDir)) {
      return send(res, 200, { posts: [], total: 0 });
    }

    for (const name of fs.readdirSync(commonsDir)) {
      // Skip non-.md files, reflected files, archive dir
      if (!name.endsWith('.md')) continue;
      if (name.includes('.reflected.')) continue;
      if (name === 'archive') continue;

      const filePath = path.join(commonsDir, name);
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) continue;

      // Filename format: {soulId}_{ISOtimestamp}.md
      const nameWithout = name.replace(/\.md$/, '');
      const lastUnderscore = nameWithout.lastIndexOf('_');
      if (lastUnderscore === -1) continue;
      const soulId = nameWithout.slice(0, lastUnderscore);

      const parsed = parseCommonsPost(filePath);
      if (!parsed) continue;

      // Determine display name
      const isStandalone = soulId.startsWith('s-');
      const displayName = isStandalone
        ? (soulNames[soulId] || soulId)
        : `Soul ${soulId.slice(0, 6)}`;

      posts.push({
        id: nameWithout,
        soulId,
        displayName,
        isStandalone,
        postedAt: parsed.postedAt,
        tags: parsed.tags,
        content: parsed.content,
      });
    }

    // Sort newest first
    posts.sort((a, b) => new Date(b.postedAt) - new Date(a.postedAt));

    send(res, 200, { posts, total: posts.length });
  } catch (err) {
    log.error(`Commons API error: ${err.message}`);
    send(res, 500, { error: 'Server error' });
  }
}

function handleCommonsPage(req, res) {
  const commonsHtml = path.join(STATIC_DIR, 'commons.html');
  if (fs.existsSync(commonsHtml)) {
    sendFile(res, commonsHtml);
  } else {
    send(res, 404, { error: 'Commons page not found' }, 'text/plain');
  }
}

function handleStatic(req, res, pathname) {
  // Serve static files from static/ directory
  const safeName = path.basename(pathname);
  if (pathname === '/' || pathname === '/index.html') {
    const indexPath = path.join(STATIC_DIR, 'index.html');
    if (fs.existsSync(indexPath)) {
      sendFile(res, indexPath);
      return true;
    }
  }

  const filePath = path.join(STATIC_DIR, safeName);
  if (filePath.startsWith(STATIC_DIR) && fs.existsSync(filePath)) {
    sendFile(res, filePath);
    return true;
  }
  return false;
}

// --- Server ---

function startServer() {
  const port = parseInt(process.env.WEB_PORT || '3001', 10);
  const host = process.env.WEB_HOST || '0.0.0.0';

  server = http.createServer(async (req, res) => {
    const { pathname, params } = parseUrl(req.url);
    const method = req.method;

    try {
      // Public soul commons (no auth required)
      if (method === 'GET' && pathname === '/commons') {
        return handleCommonsPage(req, res);
      }
      if (method === 'GET' && pathname === '/api/commons') {
        return handleCommonsAPI(req, res);
      }

      // Dashboard entry (token exchange)
      if (method === 'GET' && pathname === '/dash') {
        return handleDash(req, res, params);
      }

      // Google Drive OAuth callback
      if (method === 'GET' && pathname === '/drive-auth/callback') {
        const error = params.get('error');
        if (error) {
          send(res, 400, `<html><body><h2>Authorization cancelled</h2><p>${error}</p><p>You can close this tab.</p></body></html>`, 'text/html; charset=utf-8');
          return;
        }
        const code = params.get('code');
        const state = params.get('state');
        if (!code || !state) {
          send(res, 400, '<html><body><h2>Invalid callback</h2></body></html>', 'text/html; charset=utf-8');
          return;
        }
        try {
          await driveAuth.handleCallback(code, state);
          send(res, 200, `<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{font-family:sans-serif;max-width:500px;margin:80px auto;padding:0 20px;text-align:center}h2{color:#2d7a2d}</style></head><body>
            <h2>✓ Google Drive Connected!</h2>
            <p>Your workspace is now linked to Google Drive.</p>
            <p>Ask your AI companion to sync or manage files — it has full Drive access.</p>
            <p>You can close this tab.</p>
          </body></html>`, 'text/html; charset=utf-8');
        } catch (err) {
          log.error(`Drive auth callback error: ${err.message}`);
          send(res, 500, '<html><body><h2>Connection failed</h2><p>Please try again.</p></body></html>', 'text/html; charset=utf-8');
        }
        return;
      }

      // API routes
      if (method === 'GET' && pathname === '/api/files') {
        return handleListFiles(req, res, params);
      }
      if (method === 'GET' && pathname === '/api/file') {
        return handleGetFile(req, res, params);
      }
      if (method === 'POST' && pathname === '/api/upload') {
        return handleUpload(req, res, params);
      }
      if (method === 'DELETE' && pathname === '/api/file') {
        return handleDelete(req, res, params);
      }

      // Static files (authenticated pages)
      if (method === 'GET') {
        // For root and static assets, check session first (except for static assets needed for login page)
        const isAsset = pathname.endsWith('.css') || pathname.endsWith('.js') || pathname.endsWith('.ico');
        if (pathname === '/' || isAsset) {
          if (handleStatic(req, res, pathname)) return;
        }
      }

      send(res, 404, { error: 'Not found' });
    } catch (err) {
      log.error(`Request error ${method} ${pathname}: ${err.message}`);
      send(res, 500, { error: 'Server error' });
    }
  });

  server.listen(port, host, () => {
    log.info(`Web dashboard listening on http://${host}:${port}`);
  });

  return server;
}

function stopServer() {
  if (server) {
    server.close();
    server = null;
  }
  auth.destroySessions();
  log.info('Web dashboard stopped');
}

module.exports = { startServer, stopServer, createWebToken: auth.createWebToken, log };
