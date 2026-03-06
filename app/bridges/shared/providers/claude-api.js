const { BaseProvider, StreamHandle } = require('./base');

let Anthropic;
try {
  Anthropic = require('@anthropic-ai/sdk');
} catch {
  // SDK not installed — will throw at runtime if this provider is used
  Anthropic = null;
}

const DEFAULT_MODEL = 'claude-sonnet-4-6';
const DEFAULT_MAX_TOKENS = 8192;

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
  _buildParams(options) {
    const params = {
      model: options.model || DEFAULT_MODEL,
      max_tokens: options.maxTokens || DEFAULT_MAX_TOKENS,
      messages: [{ role: 'user', content: options.prompt }],
    };

    if (options.systemPrompt) {
      params.system = options.systemPrompt;
    }

    return params;
  }

  /**
   * Non-streaming run.
   */
  async run(options) {
    const client = this._getClient();
    const params = this._buildParams(options);

    const response = await client.messages.create(params);

    const text = response.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');

    const inputTokens = response.usage?.input_tokens || 0;
    const outputTokens = response.usage?.output_tokens || 0;

    return {
      text,
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      raw: response,
    };
  }

  /**
   * Streaming run — uses Anthropic streaming API.
   */
  runStream(options) {
    const handle = new StreamHandle();

    // Kick off async streaming
    (async () => {
      try {
        const client = this._getClient();
        const params = this._buildParams(options);

        const stream = await client.messages.stream(params);

        let inputTokens = 0;
        let outputTokens = 0;
        const textBlocks = [];

        stream.on('message', (msg) => {
          if (msg.usage) {
            inputTokens = msg.usage.input_tokens || 0;
            outputTokens = msg.usage.output_tokens || 0;
          }
        });

        stream.on('text', (text) => {
          textBlocks.push(text);
          handle.emit('text_delta', { text });
        });

        stream.on('error', (err) => {
          handle.emit('error', { message: err.message });
        });

        stream.on('end', () => {
          handle.emit('usage', { inputTokens, outputTokens });
          handle.emit('result', {
            text: textBlocks.join(''),
            inputTokens,
            outputTokens,
          });
          handle.emit('close');
        });

        // Wire up kill to abort the stream
        handle.kill = () => {
          if (!handle._killed) {
            handle._killed = true;
            stream.abort();
            handle.emit('close');
          }
        };
      } catch (err) {
        handle.emit('error', { message: err.message });
        handle.emit('close');
      }
    })();

    return handle;
  }
}

module.exports = { ClaudeAPIProvider };
