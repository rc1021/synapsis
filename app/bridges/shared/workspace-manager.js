const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const { createLogger } = require('./logger');
const log = createLogger('workspace', {
  logDir: process.env.LOG_DIR || path.join(__dirname, '..', '..', 'logs'),
});

const WORKSPACES_DIR = path.join(__dirname, '..', '..', 'workspaces');
const INDEX_DIR = path.join(WORKSPACES_DIR, 'index');
const DATA_DIR = path.join(WORKSPACES_DIR, 'data');
const INVITES_DIR = path.join(WORKSPACES_DIR, 'invites');
const BIND_TOKENS_DIR = path.join(WORKSPACES_DIR, 'bind-tokens');
const TEMPLATE_DIR = path.join(__dirname, '..', '..', 'workspace-template');
const SYNC_PROMPT_PATH = path.join(DATA_DIR, 'SYNC_PROMPT.md');

// --- Helpers ---

function sanitizeId(id) {
  return id.replace(/[^a-zA-Z0-9]/g, '');
}

function randomHex(bytes) {
  return crypto.randomBytes(bytes).toString('hex');
}

function randomCode(length) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const buf = crypto.randomBytes(length);
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars[buf[i] % chars.length];
  }
  return result;
}

/**
 * Build 4-layer shard path from first 8 chars of an id.
 * e.g. "1234567890" → "12/34/56/78"
 */
function shardPath4(id) {
  const s = id.slice(0, 8).padEnd(8, '0');
  return path.join(s.slice(0, 2), s.slice(2, 4), s.slice(4, 6), s.slice(6, 8));
}

/**
 * Build 2-layer shard path from first 4 chars.
 * e.g. "ABCDEF123456" → "AB/CD"
 */
function shardPath2(id) {
  const s = id.slice(0, 4).padEnd(4, '0');
  return path.join(s.slice(0, 2), s.slice(2, 4));
}

/**
 * Workspace relative path from workspace ID.
 * e.g. "a1b2c3d4e5f67890" → "a1/b2/c3/d4/a1b2c3d4e5f67890"
 */
function workspaceRelPath(wsId) {
  return path.join(shardPath4(wsId), wsId);
}

function workspaceAbsPath(wsId) {
  return path.join(DATA_DIR, workspaceRelPath(wsId));
}

// --- Index ---

function indexPath(bridge, userId) {
  const safe = sanitizeId(userId);
  return path.join(INDEX_DIR, bridge, shardPath4(safe), `${safe}.json`);
}

function readIndex(bridge, userId) {
  const p = indexPath(bridge, userId);
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return data.w || null;
  } catch {
    return null;
  }
}

function writeIndex(bridge, userId, wsRelPath) {
  const p = indexPath(bridge, userId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ w: wsRelPath }));
}

// --- Workspace lookup ---

/**
 * Resolve a bridge:userId to an absolute workspace path.
 * Returns null if user is not registered.
 */
function resolveWorkspace(bridge, userId) {
  const rel = readIndex(bridge, userId);
  if (!rel) return null;
  return path.join(DATA_DIR, rel);
}

/**
 * Extract workspace ID from a relative workspace path.
 * e.g. "a1/b2/c3/d4/a1b2c3d4e5f67890" → "a1b2c3d4e5f67890"
 */
function wsIdFromRel(relPath) {
  return path.basename(relPath);
}

// --- Profile ---

function profilePath(wsAbsPath) {
  return path.join(wsAbsPath, 'profile.json');
}

function readProfile(wsAbsPath) {
  try {
    return JSON.parse(fs.readFileSync(profilePath(wsAbsPath), 'utf-8'));
  } catch {
    return null;
  }
}

function writeProfile(wsAbsPath, profile) {
  fs.writeFileSync(profilePath(wsAbsPath), JSON.stringify(profile, null, 2));
}

// --- Session store path ---

function sessionStorePath(wsAbsPath) {
  const wsId = path.basename(wsAbsPath);
  return path.join(path.dirname(wsAbsPath), `${wsId}-sessions.json`);
}

// --- Workspace creation ---

function createWorkspace(bridge, userId) {
  const wsId = randomHex(8); // 16 hex chars
  const rel = workspaceRelPath(wsId);
  const abs = path.join(DATA_DIR, rel);

  // Copy template
  fs.mkdirSync(abs, { recursive: true });
  execSync(`cp -r "${TEMPLATE_DIR}/"* "${abs}/"`);

  // Create profile
  const appPkg = require('../../package.json');
  const profile = {
    createdAt: new Date().toISOString(),
    templateVersion: appPkg.version,
    bindings: [`${bridge}:${userId}`],
  };
  writeProfile(abs, profile);

  // Create empty jobs.json
  fs.writeFileSync(path.join(abs, 'jobs.json'), JSON.stringify({ jobs: [] }, null, 2));

  // Create index
  writeIndex(bridge, userId, rel);

  log.info(`Workspace created: ${wsId} for ${bridge}:${userId}`);
  return { wsId, wsPath: abs, wsRel: rel };
}

// --- Invites ---

function invitePath(code) {
  return path.join(INVITES_DIR, shardPath2(code), `${code}.json`);
}

function createInvite(fromWsRel) {
  const code = randomCode(14);
  const p = invitePath(code);
  fs.mkdirSync(path.dirname(p), { recursive: true });

  const invite = {
    from: fromWsRel,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  };
  fs.writeFileSync(p, JSON.stringify(invite));
  log.info(`Invite created: ${code} from ${fromWsRel}`);
  return code;
}

/**
 * Consume an invite code atomically. Returns invite data or null if invalid/expired.
 */
function consumeInvite(code) {
  const p = invitePath(code);
  const consumed = p + '.used';

  try {
    // Atomic rename — first to rename wins
    fs.renameSync(p, consumed);
  } catch {
    return null;
  }

  try {
    const data = JSON.parse(fs.readFileSync(consumed, 'utf-8'));
    // Check expiry
    if (new Date(data.expiresAt) < new Date()) {
      fs.unlinkSync(consumed);
      return null;
    }
    // Clean up consumed file
    fs.unlinkSync(consumed);
    return data;
  } catch {
    return null;
  }
}

// --- Bind tokens ---

function bindTokenPath(token) {
  return path.join(BIND_TOKENS_DIR, shardPath2(token), `${token}.json`);
}

function createBindToken(wsRel) {
  const token = randomCode(14);
  const p = bindTokenPath(token);
  fs.mkdirSync(path.dirname(p), { recursive: true });

  const data = {
    workspaceId: wsRel,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
  };
  fs.writeFileSync(p, JSON.stringify(data));
  log.info(`Bind token created for ${wsRel}`);
  return token;
}

/**
 * Consume a bind token atomically. Returns token data or null.
 */
function consumeBindToken(token) {
  const p = bindTokenPath(token);
  const consumed = p + '.used';

  try {
    fs.renameSync(p, consumed);
  } catch {
    return null;
  }

  try {
    const data = JSON.parse(fs.readFileSync(consumed, 'utf-8'));
    if (new Date(data.expiresAt) < new Date()) {
      fs.unlinkSync(consumed);
      return null;
    }
    fs.unlinkSync(consumed);
    return data;
  } catch {
    return null;
  }
}

/**
 * Bind a new bridge account to an existing workspace.
 */
function bindAccount(bridge, userId, wsRel) {
  const wsAbs = path.join(DATA_DIR, wsRel);
  const profile = readProfile(wsAbs);
  if (!profile) return false;

  const binding = `${bridge}:${userId}`;
  if (!profile.bindings.includes(binding)) {
    profile.bindings.push(binding);
    writeProfile(wsAbs, profile);
  }

  writeIndex(bridge, userId, wsRel);
  log.info(`Account bound: ${binding} → ${wsRel}`);
  return true;
}

// --- SYNC_PROMPT ---

function readSyncPrompt() {
  try {
    return fs.readFileSync(SYNC_PROMPT_PATH, 'utf-8');
  } catch {
    return '';
  }
}

// --- List all workspaces ---

function listAllWorkspaces() {
  try {
    const result = execSync(
      `find "${INDEX_DIR}" -type f -name '*.json' 2>/dev/null`,
      { encoding: 'utf-8', timeout: 10000 }
    ).trim();
    if (!result) return [];

    const seen = new Set();
    const workspaces = [];

    for (const file of result.split('\n').filter(Boolean)) {
      try {
        const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
        const rel = data.w;
        if (!rel || seen.has(rel)) continue;
        seen.add(rel);
        workspaces.push({
          wsId: path.basename(rel),
          wsAbsPath: path.join(DATA_DIR, rel),
        });
      } catch (err) {
        log.warn(`Failed to parse index file ${file}: ${err.message}`);
      }
    }

    return workspaces;
  } catch (err) {
    log.warn(`Failed to list workspaces: ${err.message}`);
    return [];
  }
}

// --- Talk history ---

const TALK_HISTORY_FILE = 'talk-history.jsonl';
const TALK_HISTORY_MAX_FIELD = 500;

function appendTalkHistory(wsPath, userMsg, assistantMsg) {
  try {
    const filePath = path.join(wsPath, TALK_HISTORY_FILE);
    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      u: userMsg.slice(0, TALK_HISTORY_MAX_FIELD),
      a: assistantMsg.slice(0, TALK_HISTORY_MAX_FIELD),
    }) + '\n';
    fs.appendFileSync(filePath, entry);
  } catch (err) {
    log.warn(`Failed to append talk-history: ${err.message}`);
  }
}

// --- User jobs path ---

function userJobsPath(wsAbsPath) {
  return path.join(wsAbsPath, 'jobs.json');
}

// --- Exports ---

module.exports = {
  WORKSPACES_DIR,
  INDEX_DIR,
  DATA_DIR,
  INVITES_DIR,
  BIND_TOKENS_DIR,
  TEMPLATE_DIR,
  SYNC_PROMPT_PATH,
  sanitizeId,
  shardPath4,
  shardPath2,
  workspaceRelPath,
  workspaceAbsPath,
  indexPath,
  readIndex,
  writeIndex,
  resolveWorkspace,
  wsIdFromRel,
  profilePath,
  readProfile,
  writeProfile,
  sessionStorePath,
  createWorkspace,
  createInvite,
  consumeInvite,
  createBindToken,
  consumeBindToken,
  bindAccount,
  readSyncPrompt,
  appendTalkHistory,
  userJobsPath,
  listAllWorkspaces,
};
