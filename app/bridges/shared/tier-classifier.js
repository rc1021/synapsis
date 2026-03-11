/**
 * Tier classifier — uses Haiku to determine the complexity tier of a user prompt.
 * Returns 'quick' | 'standard' | 'deep'.
 *
 * Runs a single non-streaming API call, bypassing the full runner stack.
 */
const path = require('path');
const { createLogger } = require('./logger');
const log = createLogger('tier-classifier', {
  logDir: process.env.LOG_DIR || path.join(__dirname, '..', '..', 'logs'),
});

const CLASSIFIER_MODEL = 'claude-haiku-4-5-20251001';
const CLASSIFIER_MAX_TOKENS = 10;
const CLASSIFIER_TIMEOUT_MS = 8000;

const SYSTEM_PROMPT =
  'You are a request complexity classifier. ' +
  'Classify the user message into exactly one tier:\n' +
  '- quick: simple questions, single-step tasks, short translations, factual lookups\n' +
  '- standard: coding help, explanations, moderate analysis, multi-step but clear tasks\n' +
  '- deep: complex reasoning, long document analysis, research, ambiguous or multi-layered problems\n' +
  'Reply with exactly one word: quick, standard, or deep.';

let _client = null;

function getClient() {
  if (_client) return _client;
  let Anthropic;
  try {
    Anthropic = require('@anthropic-ai/sdk');
  } catch {
    throw new Error('tier-classifier requires @anthropic-ai/sdk');
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('tier-classifier requires ANTHROPIC_API_KEY');
  _client = new Anthropic({ apiKey });
  return _client;
}

/**
 * Classify a prompt into a tier.
 * Falls back to 'standard' on any error.
 *
 * @param {string} prompt
 * @returns {Promise<'quick'|'standard'|'deep'>}
 */
async function classifyTier(prompt) {
  try {
    const client = getClient();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CLASSIFIER_TIMEOUT_MS);

    let response;
    try {
      response = await client.messages.create(
        {
          model: CLASSIFIER_MODEL,
          max_tokens: CLASSIFIER_MAX_TOKENS,
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: prompt.slice(0, 500) }],
        },
        { signal: controller.signal },
      );
    } finally {
      clearTimeout(timer);
    }

    const raw = (response.content?.[0]?.text || '').trim().toLowerCase();
    if (raw === 'quick' || raw === 'standard' || raw === 'deep') {
      log.info(`Classified as: ${raw}`);
      return raw;
    }

    // Handle cases where the model adds extra text
    if (raw.includes('quick')) return 'quick';
    if (raw.includes('deep')) return 'deep';

    log.warn(`Unexpected classifier output: "${raw}", defaulting to standard`);
    return 'standard';
  } catch (err) {
    log.warn(`Classifier failed: ${err.message}, defaulting to standard`);
    return 'standard';
  }
}

module.exports = { classifyTier };
