const fs = require('fs');
const path = require('path');

/**
 * Create a logger instance that writes to stdout + daily log files.
 *
 * @param {string} name - Logger name (used as filename prefix, e.g. "scheduler" → "scheduler-2026-03-06.log")
 * @param {object} options
 * @param {string} options.logDir - Directory for log files
 * @param {number} [options.retainDays=7] - Number of days to keep log files
 * @returns {{ info, warn, error, debug }}
 */
function createLogger(name, { logDir, retainDays = 7 } = {}) {
  if (!logDir) {
    throw new Error(`createLogger('${name}'): logDir is required`);
  }

  try { fs.mkdirSync(logDir, { recursive: true }); } catch (err) {
    process.stderr.write(`[logger] Failed to create logDir ${logDir}: ${err.message}\n`);
  }

  function dateStr(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function logFilePath() {
    return path.join(logDir, `${name}-${dateStr(new Date())}.log`);
  }

  function cleanup() {
    try {
      const files = fs.readdirSync(logDir);
      const prefix = `${name}-`;
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - retainDays);
      const cutoffStr = dateStr(cutoff);

      for (const file of files) {
        if (!file.startsWith(prefix) || !file.endsWith('.log')) continue;
        const fileDate = file.slice(prefix.length, prefix.length + 10);
        if (fileDate < cutoffStr) {
          fs.unlinkSync(path.join(logDir, file));
        }
      }
    } catch (err) {
      process.stderr.write(`[logger] Log cleanup error: ${err.message}\n`);
    }
  }

  function write(level, ...args) {
    const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
    const line = `[${new Date().toISOString()}] [${level}] ${msg}\n`;
    process.stdout.write(line);
    try {
      fs.appendFileSync(logFilePath(), line);
    } catch (err) {
      process.stderr.write(`[logger] Failed to write log file: ${err.message}\n`);
    }
  }

  cleanup();
  setInterval(cleanup, 60 * 60 * 1000);

  return {
    info: (...args) => write('INFO', ...args),
    warn: (...args) => write('WARN', ...args),
    error: (...args) => write('ERROR', ...args),
    debug: (...args) => {
      if (process.env.DEBUG) write('DEBUG', ...args);
    },
  };
}

module.exports = { createLogger };
