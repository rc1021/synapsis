const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createLogger } = require('../logger');

const log = createLogger('tts-merge', {
  logDir: process.env.LOG_DIR || path.join(__dirname, '..', '..', '..', 'logs'),
});

let ffmpegAvailable; // cached after first check

async function checkFfmpeg() {
  if (ffmpegAvailable !== undefined) return ffmpegAvailable;
  ffmpegAvailable = await new Promise((resolve) => {
    const proc = spawn('ffmpeg', ['-version']);
    proc.on('error', () => resolve(false));
    proc.on('exit', (code) => resolve(code === 0));
  });
  return ffmpegAvailable;
}

/**
 * Group buffers so each group's total size stays within maxBytes (greedy, preserves order).
 * A single buffer larger than maxBytes becomes its own group.
 */
function groupBySize(buffers, maxBytes) {
  const groups = [];
  let current = [];
  let currentSize = 0;

  for (const buf of buffers) {
    if (current.length > 0 && currentSize + buf.length > maxBytes) {
      groups.push(current);
      current = [];
      currentSize = 0;
    }
    current.push(buf);
    currentSize += buf.length;
  }
  if (current.length > 0) groups.push(current);

  return groups;
}

/**
 * Merge a group of MP3 buffers into a single Buffer via ffmpeg's concat demuxer
 * (stream copy, no re-encode). Falls back to Buffer.concat if ffmpeg is unavailable
 * or the merge fails.
 */
async function mergeBuffers(buffers) {
  if (buffers.length === 1) return buffers[0];
  if (!(await module.exports.checkFfmpeg())) return Buffer.concat(buffers);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'speak-'));
  try {
    const lines = buffers.map((buf, i) => {
      const p = path.join(tmpDir, `chunk${i}.mp3`);
      fs.writeFileSync(p, buf);
      return `file '${p}'`;
    });
    const listPath = path.join(tmpDir, 'list.txt');
    fs.writeFileSync(listPath, lines.join('\n'));

    const outPath = path.join(tmpDir, 'out.mp3');
    await new Promise((resolve, reject) => {
      const proc = spawn('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', outPath]);
      let stderr = '';
      proc.stderr.on('data', (d) => { stderr += d; });
      proc.on('error', reject);
      proc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-300)}`))));
    });
    return fs.readFileSync(outPath);
  } catch (err) {
    log.warn(`ffmpeg merge failed, falling back to concat: ${err.message}`);
    return Buffer.concat(buffers);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

module.exports = { mergeBuffers, groupBySize, checkFfmpeg };
