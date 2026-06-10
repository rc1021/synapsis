const path = require('path');
const { createLogger } = require('../logger');
const { chunkText } = require('./chunk');

const log = createLogger('tts-google', {
  logDir: process.env.LOG_DIR || path.join(__dirname, '..', '..', '..', 'logs'),
});

const TTS_API_URL = 'https://texttospeech.googleapis.com/v1/text:synthesize';
const MAX_CHUNK_BYTES = 4800;
const DEFAULT_VOICE = 'cmn-TW-Wavenet-A';
const TIMEOUT_MS = 30000;
const MAX_CHUNKS = 30;

function isConfigured() {
  return !!process.env.GOOGLE_TTS_API_KEY;
}

const configHint = 'GOOGLE_TTS_API_KEY';

async function synthesizeChunk(text) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(`${TTS_API_URL}?key=${process.env.GOOGLE_TTS_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: { text },
        voice: {
          languageCode: 'cmn-TW',
          name: process.env.GOOGLE_TTS_VOICE || DEFAULT_VOICE,
        },
        audioConfig: { audioEncoding: 'MP3' },
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const body = await res.json();
        if (body && body.error && body.error.message) detail = body.error.message;
      } catch (err) {
        log.warn(`Failed to parse Google TTS error response: ${err.message}`);
      }
      throw new Error(detail);
    }

    const data = await res.json();
    return Buffer.from(data.audioContent, 'base64');
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('TTS request timed out');
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

async function synthesize(text) {
  const allChunks = chunkText(text, { maxBytes: MAX_CHUNK_BYTES });
  const truncated = allChunks.length > MAX_CHUNKS;
  const chunks = allChunks.slice(0, MAX_CHUNKS);

  const buffers = [];
  const errors = [];

  for (const chunk of chunks) {
    try {
      buffers.push(await synthesizeChunk(chunk));
    } catch (err) {
      log.warn(`Google TTS chunk failed: ${err.message}`);
      buffers.push(null);
      errors.push(err.message);
    }
  }

  return {
    buffers,
    totalChunks: allChunks.length,
    usedChunks: chunks.length,
    truncated,
    errors,
  };
}

module.exports = { isConfigured, configHint, synthesize };
