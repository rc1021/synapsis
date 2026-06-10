const path = require('path');
const { createLogger } = require('../logger');
const { chunkText } = require('./chunk');

const log = createLogger('tts-openai', {
  logDir: process.env.LOG_DIR || path.join(__dirname, '..', '..', '..', 'logs'),
});

const TTS_API_URL = 'https://api.openai.com/v1/audio/speech';
const MAX_CHUNK_CHARS = 4000;
const DEFAULT_MODEL = 'gpt-4o-mini-tts';
const DEFAULT_VOICE = 'alloy';
const TIMEOUT_MS = 30000;
const MAX_CHUNKS = 30;

function isConfigured() {
  return !!process.env.OPENAI_API_KEY;
}

const configHint = 'OPENAI_API_KEY';

async function synthesizeChunk(text) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(TTS_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: process.env.OPENAI_TTS_MODEL || DEFAULT_MODEL,
        input: text,
        voice: process.env.OPENAI_TTS_VOICE || DEFAULT_VOICE,
        response_format: 'mp3',
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const body = await res.json();
        if (body && body.error && body.error.message) detail = body.error.message;
      } catch (err) {
        log.warn(`Failed to parse OpenAI TTS error response: ${err.message}`);
      }
      throw new Error(detail);
    }

    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('TTS request timed out');
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

async function synthesize(text) {
  const allChunks = chunkText(text, { maxChars: MAX_CHUNK_CHARS });
  const truncated = allChunks.length > MAX_CHUNKS;
  const chunks = allChunks.slice(0, MAX_CHUNKS);

  const buffers = [];
  const errors = [];

  for (const chunk of chunks) {
    try {
      buffers.push(await synthesizeChunk(chunk));
    } catch (err) {
      log.warn(`OpenAI TTS chunk failed: ${err.message}`);
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
