const EventEmitter = require('events');

/**
 * Base class for AI providers.
 *
 * All providers must implement:
 *   - runStream(options) → StreamHandle (EventEmitter with kill())
 *   - Optionally override run(options) for non-streaming use
 *
 * Standardized stream events:
 *   - 'text_delta'   { text }
 *   - 'tool_start'   { name, input, id }
 *   - 'tool_end'     { id }
 *   - 'usage'        { inputTokens, outputTokens }
 *   - 'result'       { text, inputTokens, outputTokens }
 *   - 'error'        { message }
 */
class BaseProvider {
  constructor(name) {
    this.name = name;
  }

  /**
   * Run a prompt and return the final result (non-streaming).
   * Default implementation wraps runStream().
   *
   * @param {ProviderOptions} options
   * @returns {Promise<ProviderResult>}
   */
  run(options) {
    return new Promise((resolve, reject) => {
      const stream = this.runStream(options);
      const textBlocks = [];
      let inputTokens = 0;
      let outputTokens = 0;

      stream.on('text_delta', (e) => { textBlocks.push(e.text); });

      stream.on('usage', (e) => {
        if (e.inputTokens) inputTokens = e.inputTokens;
        if (e.outputTokens) outputTokens = e.outputTokens;
      });

      stream.on('result', (e) => {
        const text = e.text || textBlocks.join('');
        resolve({
          text,
          inputTokens: e.inputTokens || inputTokens,
          outputTokens: e.outputTokens || outputTokens,
          totalTokens: (e.inputTokens || inputTokens) + (e.outputTokens || outputTokens),
        });
      });

      stream.on('error', (e) => {
        reject(new Error(e.message || 'Provider error'));
      });

      // If stream closes without result event, resolve with accumulated text
      stream.on('close', () => {
        const text = textBlocks.join('');
        resolve({
          text,
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
        });
      });

      // Timeout support
      if (options.timeout) {
        setTimeout(() => {
          stream.kill();
          reject(new Error(`Provider timeout after ${options.timeout}ms`));
        }, options.timeout);
      }
    });
  }

  /**
   * Run a prompt with streaming events.
   *
   * @param {ProviderOptions} options
   * @returns {StreamHandle} EventEmitter with kill() method
   */
  runStream(_options) {
    throw new Error(`${this.name}: runStream() not implemented`);
  }
}

/**
 * StreamHandle — EventEmitter with a kill() method.
 */
class StreamHandle extends EventEmitter {
  constructor() {
    super();
    this._killed = false;
  }

  kill() {
    this._killed = true;
    this.emit('close');
  }
}

module.exports = { BaseProvider, StreamHandle };

/**
 * @typedef {object} ProviderOptions
 * @property {string} prompt
 * @property {string} [sessionId]
 * @property {boolean} [resume=false]
 * @property {string} [model]
 * @property {string} [systemPrompt]
 * @property {string[]} [allowedTools]
 * @property {string[]} [disallowedTools]
 * @property {number} [maxBudgetUsd]
 * @property {string} [cwd]
 * @property {boolean} [sandbox=false]
 * @property {number} [timeout]
 */

/**
 * @typedef {object} ProviderResult
 * @property {string} text
 * @property {number} inputTokens
 * @property {number} outputTokens
 * @property {number} totalTokens
 */
