const providers = new Map();

function register(name, factory) {
  providers.set(name, { factory, instance: null });
}

function get(name) {
  const providerName = name || process.env.TTS_PROVIDER || 'google';
  const entry = providers.get(providerName);
  if (!entry) {
    throw new Error(`Unknown TTS provider: "${providerName}". Available: ${[...providers.keys()].join(', ')}`);
  }
  if (!entry.instance) entry.instance = entry.factory();
  return entry.instance;
}

function list() {
  return [...providers.keys()];
}

register('google', () => require('./google'));
register('openai', () => require('./openai'));

module.exports = { register, get, list };
