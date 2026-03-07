/**
 * Provider registry — maps provider names to provider instances.
 *
 * Usage:
 *   const registry = require('./providers/registry');
 *   const provider = registry.get();           // uses AI_PROVIDER env
 *   const provider = registry.get('claude-api'); // explicit
 */

const providers = new Map();

function register(name, factory) {
  providers.set(name, { factory, instance: null });
}

/**
 * Get a provider instance by name. Lazy-initializes on first access.
 * @param {string} [name] - Provider name. Defaults to AI_PROVIDER env or 'claude-api'.
 * @returns {import('./base').BaseProvider}
 */
function get(name) {
  const providerName = name || process.env.AI_PROVIDER || 'claude-api';
  const entry = providers.get(providerName);
  if (!entry) {
    throw new Error(`Unknown AI provider: "${providerName}". Available: ${[...providers.keys()].join(', ')}`);
  }
  if (!entry.instance) {
    entry.instance = entry.factory();
  }
  return entry.instance;
}

/**
 * List all registered provider names.
 * @returns {string[]}
 */
function list() {
  return [...providers.keys()];
}

// --- Register built-in providers ---

register('claude-cli', () => {
  const { ClaudeCLIProvider } = require('./claude-cli');
  return new ClaudeCLIProvider();
});

register('claude-api', () => {
  const { ClaudeAPIProvider } = require('./claude-api');
  return new ClaudeAPIProvider();
});

module.exports = { register, get, list };
