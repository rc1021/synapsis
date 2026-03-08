/**
 * Engagement tracking — records whether users respond to job-initiated messages.
 *
 * Flow:
 * 1. notifier sends a job message → writePending() records it
 * 2. User replies in channel → matchReply() checks pending entries and scores engagement
 *
 * Data lives in {workspace}/engagement.jsonl
 */

const fs = require('fs');
const { join } = require('path');

const ENGAGEMENT_FILE = 'engagement.jsonl';
const PENDING_FILE = '.engagement-pending.json';
const PENDING_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Record a pending engagement entry after a job message is sent.
 */
function writePending(wsAbsPath, { jobId, messageId, channelId, timestamp }) {
  const pendingPath = join(wsAbsPath, PENDING_FILE);
  let pending = [];

  try {
    if (fs.existsSync(pendingPath)) {
      pending = JSON.parse(fs.readFileSync(pendingPath, 'utf-8'));
    }
  } catch {
    pending = [];
  }

  // Expire old entries
  const now = Date.now();
  pending = pending.filter(e => (now - new Date(e.ts).getTime()) < PENDING_EXPIRY_MS);

  pending.push({
    jobId,
    messageId,
    channelId,
    ts: timestamp || new Date().toISOString(),
  });

  fs.writeFileSync(pendingPath, JSON.stringify(pending, null, 2));
}

/**
 * Try to match a user reply to a pending job message.
 * Call this when a user sends a message in a channel where job messages were sent.
 *
 * Returns the matched entry if found (and records engagement), or null.
 */
function matchReply(wsAbsPath, { channelId, responseLength, responseText }) {
  const pendingPath = join(wsAbsPath, PENDING_FILE);

  let pending;
  try {
    if (!fs.existsSync(pendingPath)) return null;
    pending = JSON.parse(fs.readFileSync(pendingPath, 'utf-8'));
  } catch {
    return null;
  }

  if (!pending.length) return null;

  // Find the most recent pending entry for this channel
  const now = Date.now();
  const idx = pending.findLastIndex(e =>
    e.channelId === channelId &&
    (now - new Date(e.ts).getTime()) < PENDING_EXPIRY_MS
  );

  if (idx === -1) return null;

  const entry = pending[idx];
  const responseDelayMs = now - new Date(entry.ts).getTime();
  const engagement = scoreEngagement(responseLength, responseText);

  // Write to engagement log
  const logEntry = {
    jobId: entry.jobId,
    ts: entry.ts,
    responded: true,
    responseDelayMs,
    responseLength,
    engagement,
  };

  appendLog(wsAbsPath, logEntry);

  // Remove matched entry from pending
  pending.splice(idx, 1);
  fs.writeFileSync(pendingPath, JSON.stringify(pending, null, 2));

  return logEntry;
}

/**
 * Expire old pending entries (mark as no response).
 * Call periodically (e.g., during scheduler tick).
 */
function expirePending(wsAbsPath) {
  const pendingPath = join(wsAbsPath, PENDING_FILE);

  let pending;
  try {
    if (!fs.existsSync(pendingPath)) return;
    pending = JSON.parse(fs.readFileSync(pendingPath, 'utf-8'));
  } catch {
    return;
  }

  const now = Date.now();
  const expired = [];
  const remaining = [];

  for (const entry of pending) {
    if ((now - new Date(entry.ts).getTime()) >= PENDING_EXPIRY_MS) {
      expired.push(entry);
    } else {
      remaining.push(entry);
    }
  }

  // Log expired as "none" engagement
  for (const entry of expired) {
    appendLog(wsAbsPath, {
      jobId: entry.jobId,
      ts: entry.ts,
      responded: false,
      engagement: 'none',
    });
  }

  if (remaining.length !== pending.length) {
    fs.writeFileSync(pendingPath, JSON.stringify(remaining, null, 2));
  }
}

/**
 * Score engagement level based on response characteristics.
 */
function scoreEngagement(length, text) {
  if (!length || length === 0) return 'none';

  // Check for follow-up question
  const hasQuestion = text && /[?？]/.test(text);

  if (length > 50 || hasQuestion) return 'high';
  if (length >= 10) return 'medium';
  return 'low';
}

/**
 * Append a log entry to engagement.jsonl
 */
function appendLog(wsAbsPath, entry) {
  const logPath = join(wsAbsPath, ENGAGEMENT_FILE);
  const line = JSON.stringify(entry) + '\n';
  fs.appendFileSync(logPath, line);
}

/**
 * Read engagement log entries (for self-tune job).
 * Returns array of parsed entries.
 */
function readLog(wsAbsPath, { maxEntries = 200 } = {}) {
  const logPath = join(wsAbsPath, ENGAGEMENT_FILE);
  try {
    if (!fs.existsSync(logPath)) return [];
    const lines = fs.readFileSync(logPath, 'utf-8').split('\n').filter(Boolean);
    // Take last N entries
    return lines.slice(-maxEntries).map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

module.exports = {
  writePending,
  matchReply,
  expirePending,
  scoreEngagement,
  readLog,
};
