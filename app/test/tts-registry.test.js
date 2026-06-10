'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.LOG_DIR = process.env.LOG_DIR || '/tmp/synapsis-test-logs';

const registry = require('../bridges/shared/tts/registry');

describe('tts/registry', () => {
  let originalProvider;
  let originalGoogleKey;
  let originalOpenaiKey;

  beforeEach(() => {
    originalProvider = process.env.TTS_PROVIDER;
    originalGoogleKey = process.env.GOOGLE_TTS_API_KEY;
    originalOpenaiKey = process.env.OPENAI_API_KEY;
  });

  afterEach(() => {
    if (originalProvider === undefined) delete process.env.TTS_PROVIDER;
    else process.env.TTS_PROVIDER = originalProvider;

    if (originalGoogleKey === undefined) delete process.env.GOOGLE_TTS_API_KEY;
    else process.env.GOOGLE_TTS_API_KEY = originalGoogleKey;

    if (originalOpenaiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalOpenaiKey;
  });

  it('lists registered providers', () => {
    assert.deepEqual(registry.list(), ['google', 'openai']);
  });

  it('defaults to google when TTS_PROVIDER is unset', () => {
    delete process.env.TTS_PROVIDER;
    const provider = registry.get();
    assert.equal(provider.configHint, 'GOOGLE_TTS_API_KEY');
  });

  it('returns the openai provider when requested explicitly', () => {
    const provider = registry.get('openai');
    assert.equal(provider.configHint, 'OPENAI_API_KEY');
  });

  it('respects TTS_PROVIDER env var', () => {
    process.env.TTS_PROVIDER = 'openai';
    const provider = registry.get();
    assert.equal(provider.configHint, 'OPENAI_API_KEY');
  });

  it('throws on an unknown provider name', () => {
    assert.throws(() => registry.get('does-not-exist'), /Unknown TTS provider/);
  });

  describe('isConfigured', () => {
    it('google: false when GOOGLE_TTS_API_KEY unset, true when set', () => {
      const provider = registry.get('google');

      delete process.env.GOOGLE_TTS_API_KEY;
      assert.equal(provider.isConfigured(), false);

      process.env.GOOGLE_TTS_API_KEY = 'test-key';
      assert.equal(provider.isConfigured(), true);
    });

    it('openai: false when OPENAI_API_KEY unset, true when set', () => {
      const provider = registry.get('openai');

      delete process.env.OPENAI_API_KEY;
      assert.equal(provider.isConfigured(), false);

      process.env.OPENAI_API_KEY = 'test-key';
      assert.equal(provider.isConfigured(), true);
    });
  });
});
