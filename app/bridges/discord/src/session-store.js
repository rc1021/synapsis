const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const log = require('./logger');

const SAVE_INTERVAL = 30_000; // 30 seconds
const COMPACT_THRESHOLD = parseInt(process.env.COMPACT_THRESHOLD || '80000', 10);

class SessionStore {
  /**
   * @param {number} ttlMinutes
   * @param {string} storePath - Path to the sessions JSON file
   */
  constructor(ttlMinutes = 60, storePath) {
    this.ttl = ttlMinutes * 60 * 1000;
    this.storePath = storePath;
    this.sessions = new Map(); // key -> { sessionId, lastUsed, tokenCount?, needsCompact? }
    if (this.storePath) this._load();
    this._saveTimer = setInterval(() => this._save(), SAVE_INTERVAL);
  }

  /**
   * Key rules:
   *  - Thread → thread:{channelId}
   *  - DM → dm:{userId}
   *  - Channel → channel:{channelId}:{userId}
   */
  static keyFor(message) {
    if (message.channel.isThread()) {
      return `thread:${message.channelId}`;
    }
    if (message.channel.isDMBased()) {
      return `dm:${message.author.id}`;
    }
    return `channel:${message.channelId}:${message.author.id}`;
  }

  get(key) {
    const entry = this.sessions.get(key);
    if (!entry) return null;
    if (Date.now() - entry.lastUsed > this.ttl) {
      this.sessions.delete(key);
      log.info(`Session expired: ${key}`);
      return null;
    }
    entry.lastUsed = Date.now();
    return entry.sessionId;
  }

  getOrCreate(key) {
    let sessionId = this.get(key);
    if (!sessionId) {
      sessionId = uuidv4();
      this.sessions.set(key, { sessionId, lastUsed: Date.now(), tokenCount: 0, needsCompact: false });
      log.info(`New session: ${key} -> ${sessionId}`);
    }
    return sessionId;
  }

  reset(key) {
    const had = this.sessions.delete(key);
    if (had) log.info(`Session reset: ${key}`);
    return had;
  }

  updateTokens(key, inputTokens) {
    const entry = this.sessions.get(key);
    if (!entry) return;
    entry.tokenCount = inputTokens || 0;
    if (entry.tokenCount >= COMPACT_THRESHOLD && !entry.needsCompact) {
      entry.needsCompact = true;
      log.info(`Session ${key} marked for compact (tokens: ${entry.tokenCount}, threshold: ${COMPACT_THRESHOLD})`);
    }
  }

  getCompactStatus(key) {
    const entry = this.sessions.get(key);
    if (!entry) return { needsCompact: false, sessionId: null };
    return {
      needsCompact: !!entry.needsCompact,
      sessionId: entry.sessionId,
    };
  }

  rotateSession(key) {
    const newSessionId = uuidv4();
    this.sessions.set(key, {
      sessionId: newSessionId,
      lastUsed: Date.now(),
      tokenCount: 0,
      needsCompact: false,
    });
    log.info(`Session rotated: ${key} -> ${newSessionId}`);
    return newSessionId;
  }

  _load() {
    try {
      if (this.storePath && fs.existsSync(this.storePath)) {
        const data = JSON.parse(fs.readFileSync(this.storePath, 'utf-8'));
        for (const [key, entry] of Object.entries(data)) {
          this.sessions.set(key, entry);
        }
        log.info(`Loaded ${this.sessions.size} sessions from ${this.storePath}`);
      }
    } catch (err) {
      log.warn('Failed to load sessions:', err.message);
    }
  }

  _save() {
    if (!this.storePath) return;
    try {
      const obj = Object.fromEntries(this.sessions);
      fs.writeFileSync(this.storePath, JSON.stringify(obj, null, 2));
    } catch (err) {
      log.warn('Failed to save sessions:', err.message);
    }
  }

  destroy() {
    clearInterval(this._saveTimer);
    this._save();
  }
}

module.exports = SessionStore;
