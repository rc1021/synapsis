const { BaseProvider, StreamHandle } = require('./base');
const { buildToolDefinitions, isServerTool } = require('./tool-schemas');
const { executeTool } = require('./tool-executors');
const { createLogger } = require('../logger');
const path = require('path');
const log = createLogger('claude-api', {
  logDir: process.env.LOG_DIR || path.join(__dirname, '..', '..', '..', 'logs'),
});

let Anthropic;
try {
  Anthropic = require('@anthropic-ai/sdk');
} catch {
  // SDK not installed — will throw at runtime if this provider is used
  Anthropic = null;
}

const DEFAULT_MODEL = 'claude-sonnet-4-6';
const DEFAULT_MAX_TOKENS = 16384;
const MAX_TOOL_TURNS = 50;
const MAX_RETRIES = parseInt(process.env.API_MAX_RETRIES || '3', 10);
const RETRY_BASE_DELAY_MS = 1000;

/**
 * Determine if an error is retryable (rate limit, server error, network).
 */
function isRetryableError(err) {
  if (!err) return false;
  const status = err.status || err.statusCode;
  if (status === 429 || status === 529 || (status >= 500 && status < 600)) return true;
  const msg = (err.message || '').toLowerCase();
  if (msg.includes('overloaded') || msg.includes('rate') || msg.includes('timeout') || msg.includes('econnreset') || msg.includes('socket hang up')) return true;
  return false;
}

/**
 * Sleep for ms with jitter.
 */
function sleepWithJitter(baseMs, attempt) {
  const delay = baseMs * Math.pow(2, attempt) + Math.random() * baseMs;
  return new Promise(resolve => setTimeout(resolve, delay));
}

class ClaudeAPIProvider extends BaseProvider {
  constructor() {
    super('claude-api');
    this._client = null;
  }

  _getClient() {
    if (!this._client) {
      if (!Anthropic) {
        throw new Error('claude-api provider requires @anthropic-ai/sdk. Run: npm install @anthropic-ai/sdk');
      }
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        throw new Error('claude-api provider requires ANTHROPIC_API_KEY in .env');
      }
      this._client = new Anthropic({ apiKey });
    }
    return this._client;
  }

  /**
   * Map provider options to Anthropic API params.
   */
  _buildParams(options, messages) {
    const params = {
      model: options.model || DEFAULT_MODEL,
      max_tokens: options.maxTokens || DEFAULT_MAX_TOKENS,
      messages: messages || [{ role: 'user', content: options.prompt }],
    };

    if (options.systemPrompt) {
      params.system = options.systemPrompt;
    }

    // Build tool definitions from allowedTools / disallowedTools
    const { tools } = buildToolDefinitions(options.allowedTools, options.disallowedTools);
    if (tools.length > 0) {
      params.tools = tools;
    }

    return params;
  }

  /**
   * Streaming run with multi-turn tool execution loop.
   *
   * Emits the same events as claude-cli provider:
   *   text_delta, tool_start, tool_end, usage, event, result, error, close
   */
  runStream(options) {
    const handle = new StreamHandle();

    (async () => {
      try {
        await this._toolLoop(options, handle);
      } catch (err) {
        if (!handle._killed) {
          handle.emit('error', { message: err.message });
          handle.emit('close');
        }
      }
    })();

    return handle;
  }

  /**
   * Core multi-turn tool loop.
   */
  async _toolLoop(options, handle) {
    const client = this._getClient();

    const messages = [{ role: 'user', content: options.prompt }];
    const allText = [];
    let totalInput = 0;
    let totalOutput = 0;
    let currentStream = null;

    // Wire up kill
    handle.kill = () => {
      if (!handle._killed) {
        handle._killed = true;
        if (currentStream) {
          try { currentStream.abort(); } catch (err) {
            log.warn(`Stream abort error: ${err.message}`);
          }
        }
        handle.emit('close');
      }
    };

    // Context for tool executors
    const toolCtx = {
      cwd: options.cwd || process.cwd(),
      log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      depth: options.depth || 0,
      systemPrompt: options.systemPrompt,
      runProvider: (subOpts) => this._runSubAgent(subOpts),
    };

    for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
      if (handle._killed) break;

      const params = this._buildParams(options, messages);

      // Retry loop for transient API errors (429, 5xx, network)
      let turnResult;
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        if (handle._killed) break;
        try {
          const stream = client.messages.stream(params);
          currentStream = stream;
          turnResult = await this._streamOneTurn(stream, handle);
          currentStream = null;
          break; // success
        } catch (err) {
          currentStream = null;
          if (attempt < MAX_RETRIES && isRetryableError(err) && !handle._killed) {
            log.warn(`API call failed (attempt ${attempt + 1}/${MAX_RETRIES + 1}): ${err.message}. Retrying...`);
            await sleepWithJitter(RETRY_BASE_DELAY_MS, attempt);
          } else {
            throw err;
          }
        }
      }
      if (!turnResult || handle._killed) break;

      if (handle._killed) break;

      totalInput += turnResult.inputTokens;
      totalOutput += turnResult.outputTokens;

      handle.emit('event', { turn });
      handle.emit('usage', { inputTokens: totalInput, outputTokens: totalOutput });

      // Collect text from this turn
      for (const block of turnResult.content) {
        if (block.type === 'text' && block.text) {
          allText.push(block.text);
        }
      }

      // Check stop reason
      if (turnResult.stopReason !== 'tool_use') {
        // Done — end_turn, max_tokens, etc.
        break;
      }

      // Extract tool_use blocks and execute them
      const toolUseBlocks = turnResult.content.filter(b => b.type === 'tool_use');
      if (toolUseBlocks.length === 0) break;

      // Add assistant message to conversation
      messages.push({ role: 'assistant', content: turnResult.content });

      // Execute tools and collect results
      const toolResults = [];
      for (const toolBlock of toolUseBlocks) {
        if (handle._killed) break;

        const { id, name, input } = toolBlock;

        // Emit tool_start for runner's progress tracking
        handle.emit('tool_start', { name, input, id });

        // Server-side tools (web_search) are already executed by the API
        // We should NOT see them here with stop_reason=tool_use
        // But handle gracefully just in case
        if (isServerTool(name)) {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: id,
            content: 'Server-side tool — results included in response.',
          });
          handle.emit('tool_end', { id, name, input });
          continue;
        }

        // Execute client-side tool
        try {
          const result = await executeTool(name, input, toolCtx);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: id,
            content: result,
          });
        } catch (err) {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: id,
            content: `Error: ${err.message}`,
            is_error: true,
          });
        }

        // Emit tool_end for runner's security monitor
        handle.emit('tool_end', { id, name, input });
      }

      if (handle._killed) break;

      // Add tool results to conversation
      messages.push({ role: 'user', content: toolResults });
    }

    // Emit final result
    if (!handle._killed) {
      handle.emit('result', {
        text: allText.join(''),
        inputTokens: totalInput,
        outputTokens: totalOutput,
      });
      handle.emit('close');
    }
  }

  /**
   * Stream one API turn, collecting content blocks and usage.
   * Emits text_delta and event on the handle as data arrives.
   *
   * Uses SDK's streamEvent for raw SSE events, plus 'text' for text deltas.
   */
  _streamOneTurn(stream, handle) {
    return new Promise((resolve, reject) => {
      let inputTokens = 0;
      let outputTokens = 0;
      const content = [];
      let currentBlock = null;
      let currentToolInput = '';

      // Use streamEvent to get all raw SSE events
      stream.on('streamEvent', (event) => {
        handle.emit('event', { type: event.type });

        switch (event.type) {
          case 'message_start':
            if (event.message?.usage) {
              inputTokens = event.message.usage.input_tokens || 0;
              outputTokens = event.message.usage.output_tokens || 0;
            }
            break;

          case 'message_delta':
            if (event.usage) {
              outputTokens = event.usage.output_tokens || outputTokens;
            }
            break;

          case 'content_block_start': {
            const block = event.content_block;
            if (block.type === 'tool_use') {
              currentBlock = { type: 'tool_use', id: block.id, name: block.name, input: {} };
              currentToolInput = '';
            } else if (block.type === 'text') {
              currentBlock = { type: 'text', text: '' };
            } else if (block.type === 'server_tool_use') {
              currentBlock = { type: 'server_tool_use', id: block.id, name: block.name, input: block.input || {} };
              handle.emit('tool_start', { name: block.name, input: block.input || {}, id: block.id });
            } else {
              // thinking, etc. — track but don't process
              currentBlock = { ...block };
            }
            break;
          }

          case 'content_block_delta': {
            const delta = event.delta;
            if (delta.type === 'text_delta' && delta.text) {
              if (currentBlock && currentBlock.type === 'text') {
                currentBlock.text += delta.text;
              }
              handle.emit('text_delta', { text: delta.text });
            } else if (delta.type === 'input_json_delta' && delta.partial_json) {
              currentToolInput += delta.partial_json;
            }
            break;
          }

          case 'content_block_stop': {
            if (currentBlock) {
              if (currentBlock.type === 'tool_use') {
                try {
                  currentBlock.input = JSON.parse(currentToolInput || '{}');
                } catch (err) {
                  log.warn(`Failed to parse tool input JSON for ${currentBlock.name}: ${err.message}`);
                  currentBlock.input = {};
                }
                currentToolInput = '';
              }
              if (currentBlock.type === 'server_tool_use') {
                handle.emit('tool_end', { id: currentBlock.id, name: currentBlock.name, input: currentBlock.input });
              }
              content.push(currentBlock);
              currentBlock = null;
            }
            break;
          }
        }
      });

      stream.on('error', (err) => {
        reject(err);
      });

      stream.on('end', async () => {
        try {
          const finalMsg = await stream.finalMessage();
          const stopReason = finalMsg?.stop_reason || 'end_turn';

          if (finalMsg?.usage) {
            inputTokens = finalMsg.usage.input_tokens || inputTokens;
            outputTokens = finalMsg.usage.output_tokens || outputTokens;
          }

          resolve({ content, inputTokens, outputTokens, stopReason });
        } catch (err) {
          log.warn(`finalMessage() failed, resolving with accumulated data: ${err.message}`);
          resolve({ content, inputTokens, outputTokens, stopReason: 'end_turn' });
        }
      });
    });
  }

  /**
   * Run a sub-agent call (for the Agent tool).
   * Uses non-streaming run() with reduced max_tokens.
   */
  async _runSubAgent(subOpts) {
    const client = this._getClient();
    const messages = [{ role: 'user', content: subOpts.prompt }];

    const params = {
      model: subOpts.model || DEFAULT_MODEL,
      max_tokens: 4096,
      messages,
    };

    if (subOpts.systemPrompt) {
      params.system = subOpts.systemPrompt;
    }

    // Sub-agents get tools too but with limited turns
    const { tools } = buildToolDefinitions(
      ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'],
      []
    );
    if (tools.length > 0) {
      params.tools = tools;
    }

    const toolCtx = {
      cwd: subOpts.cwd || process.cwd(),
      log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      depth: subOpts.depth || 1,
      systemPrompt: subOpts.systemPrompt,
      runProvider: (opts) => this._runSubAgent(opts),
    };

    const allText = [];
    let totalInput = 0;
    let totalOutput = 0;

    // Mini tool loop for sub-agent (max 10 turns)
    for (let turn = 0; turn < 10; turn++) {
      params.messages = messages;
      let response;
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          response = await client.messages.create(params);
          break;
        } catch (err) {
          if (attempt < MAX_RETRIES && isRetryableError(err)) {
            log.warn(`SubAgent API call failed (attempt ${attempt + 1}/${MAX_RETRIES + 1}): ${err.message}. Retrying...`);
            await sleepWithJitter(RETRY_BASE_DELAY_MS, attempt);
          } else {
            throw err;
          }
        }
      }

      totalInput += response.usage?.input_tokens || 0;
      totalOutput += response.usage?.output_tokens || 0;

      for (const block of response.content) {
        if (block.type === 'text') allText.push(block.text);
      }

      if (response.stop_reason !== 'tool_use') break;

      const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
      if (toolUseBlocks.length === 0) break;

      messages.push({ role: 'assistant', content: response.content });

      const toolResults = [];
      for (const toolBlock of toolUseBlocks) {
        if (isServerTool(toolBlock.name)) {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolBlock.id,
            content: 'Server-side tool — results included in response.',
          });
          continue;
        }

        try {
          const result = await executeTool(toolBlock.name, toolBlock.input, toolCtx);
          toolResults.push({ type: 'tool_result', tool_use_id: toolBlock.id, content: result });
        } catch (err) {
          toolResults.push({ type: 'tool_result', tool_use_id: toolBlock.id, content: `Error: ${err.message}`, is_error: true });
        }
      }

      messages.push({ role: 'user', content: toolResults });
    }

    return {
      text: allText.join(''),
      inputTokens: totalInput,
      outputTokens: totalOutput,
      totalTokens: totalInput + totalOutput,
    };
  }
}

module.exports = { ClaudeAPIProvider };
