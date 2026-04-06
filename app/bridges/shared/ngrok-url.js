/**
 * Resolve the ngrok public URL for this server.
 *
 * Priority:
 *   1. WEB_PUBLIC_URL env var (static override)
 *   2. Live query to ngrok local API (localhost:4040) — matched by WEB_PORT
 *   3. Cached URL from logs/ngrok-url.txt (written by ctl.sh at startup)
 *   4. null
 *
 * The live query result is cached in memory for CACHE_TTL ms to avoid
 * hammering the API on every call.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const NGROK_API = 'http://127.0.0.1:4040/api/tunnels';
const URL_FILE = path.join(__dirname, '../../logs/ngrok-url.txt');
const CACHE_TTL = 30_000; // 30s

let _cached = { url: null, ts: 0 };

function getPort() {
  return process.env.WEB_PORT || '3001';
}

/** Synchronous: read from env or file cache. */
function resolveSync() {
  const envUrl = (process.env.WEB_PUBLIC_URL || '').replace(/\/$/, '');
  if (envUrl) return envUrl;

  // In-memory cache still fresh?
  if (_cached.url && Date.now() - _cached.ts < CACHE_TTL) return _cached.url;

  // File fallback
  try {
    const url = fs.readFileSync(URL_FILE, 'utf8').trim();
    if (url) { _cached = { url, ts: Date.now() }; return url; }
  } catch {}
  return _cached.url || null;
}

/** Async: query ngrok API, update file + memory cache. */
function resolveAsync() {
  const envUrl = (process.env.WEB_PUBLIC_URL || '').replace(/\/$/, '');
  if (envUrl) return Promise.resolve(envUrl);

  if (_cached.url && Date.now() - _cached.ts < CACHE_TTL) return Promise.resolve(_cached.url);

  return new Promise(resolve => {
    const port = getPort();
    const req = http.get(NGROK_API, { timeout: 2000 }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try {
          const tunnels = JSON.parse(data).tunnels || [];
          const match = tunnels.find(t =>
            (t.config && t.config.addr || '').includes(`:${port}`)
          );
          if (match && match.public_url) {
            _cached = { url: match.public_url, ts: Date.now() };
            // Update file cache for ctl.sh status / other readers
            try { fs.writeFileSync(URL_FILE, match.public_url + '\n'); } catch {}
            return resolve(match.public_url);
          }
        } catch {}
        resolve(resolveSync()); // fallback to file
      });
    });
    req.on('error', () => resolve(resolveSync()));
    req.on('timeout', () => { req.destroy(); resolve(resolveSync()); });
  });
}

module.exports = { resolveSync, resolveAsync };
