const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const wm = require('../../shared/workspace-manager');

const WEB_TOKENS_DIR = path.join(wm.WORKSPACES_DIR, 'web-tokens');
const TOKEN_TTL = parseInt(process.env.WEB_TOKEN_TTL || '1800000', 10); // 30min
const SESSION_TTL = parseInt(process.env.WEB_SESSION_TTL || '1800000', 10); // 30min

// In-memory sessions: sessionId -> { wsRel, wsAbsPath, expiresAt }
const sessions = new Map();

// --- Web tokens (file-based, atomic) ---

function tokenPath(token) {
  const s = token.slice(0, 4).padEnd(4, '0');
  return path.join(WEB_TOKENS_DIR, s.slice(0, 2), s.slice(2, 4), `${token}.json`);
}

function createWebToken(wsRel) {
  const token = crypto.randomBytes(16).toString('hex');
  const p = tokenPath(token);
  fs.mkdirSync(path.dirname(p), { recursive: true });

  const data = {
    wsRel,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + TOKEN_TTL).toISOString(),
  };
  fs.writeFileSync(p, JSON.stringify(data));
  return token;
}

function consumeWebToken(token) {
  if (!token || typeof token !== 'string') return null;
  // Sanitize: only hex chars
  if (!/^[a-f0-9]+$/.test(token)) return null;

  const p = tokenPath(token);
  const consumed = p + '.used';

  try {
    fs.renameSync(p, consumed);
  } catch {
    return null;
  }

  try {
    const data = JSON.parse(fs.readFileSync(consumed, 'utf-8'));
    fs.unlinkSync(consumed);

    if (new Date(data.expiresAt) < new Date()) {
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

// --- Sessions (in-memory) ---

function createSession(wsRel) {
  const sessionId = crypto.randomBytes(16).toString('hex');
  const wsAbsPath = path.join(wm.DATA_DIR, wsRel);
  sessions.set(sessionId, {
    wsRel,
    wsAbsPath,
    expiresAt: Date.now() + SESSION_TTL,
  });
  return sessionId;
}

function getSession(sessionId) {
  if (!sessionId) return null;
  const s = sessions.get(sessionId);
  if (!s) return null;
  if (Date.now() > s.expiresAt) {
    sessions.delete(sessionId);
    return null;
  }
  // Refresh TTL on access
  s.expiresAt = Date.now() + SESSION_TTL;
  return s;
}

function destroySessions() {
  sessions.clear();
}

// Periodic cleanup of expired sessions
const _cleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now > s.expiresAt) sessions.delete(id);
  }
}, 60000);
_cleanupInterval.unref();

// --- Cookie helpers ---

function parseCookies(header) {
  const cookies = {};
  if (!header) return cookies;
  for (const pair of header.split(';')) {
    const [name, ...rest] = pair.trim().split('=');
    if (name) cookies[name.trim()] = rest.join('=').trim();
  }
  return cookies;
}

function sessionCookie(sessionId) {
  const maxAge = Math.floor(SESSION_TTL / 1000);
  return `sid=${sessionId}; HttpOnly; SameSite=Strict; Max-Age=${maxAge}; Path=/`;
}

module.exports = {
  createWebToken,
  consumeWebToken,
  createSession,
  getSession,
  destroySessions,
  parseCookies,
  sessionCookie,
};
