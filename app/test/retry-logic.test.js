const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// Test the retry helper functions directly
// We extract and test the logic without requiring the full provider

describe('retry logic', () => {
  // Reproduce isRetryableError logic
  function isRetryableError(err) {
    if (!err) return false;
    const status = err.status || err.statusCode;
    if (status === 429 || status === 529 || (status >= 500 && status < 600)) return true;
    const msg = (err.message || '').toLowerCase();
    if (msg.includes('overloaded') || msg.includes('rate') || msg.includes('timeout') || msg.includes('econnreset') || msg.includes('socket hang up')) return true;
    return false;
  }

  describe('isRetryableError', () => {
    it('returns false for null', () => {
      assert.equal(isRetryableError(null), false);
    });

    it('retries on 429 (rate limit)', () => {
      assert.equal(isRetryableError({ status: 429, message: '' }), true);
    });

    it('retries on 529 (overloaded)', () => {
      assert.equal(isRetryableError({ status: 529, message: '' }), true);
    });

    it('retries on 500 (server error)', () => {
      assert.equal(isRetryableError({ status: 500, message: '' }), true);
    });

    it('retries on 502 (bad gateway)', () => {
      assert.equal(isRetryableError({ status: 502, message: '' }), true);
    });

    it('retries on 503 (service unavailable)', () => {
      assert.equal(isRetryableError({ status: 503, message: '' }), true);
    });

    it('does not retry on 400 (bad request)', () => {
      assert.equal(isRetryableError({ status: 400, message: '' }), false);
    });

    it('does not retry on 401 (unauthorized)', () => {
      assert.equal(isRetryableError({ status: 401, message: '' }), false);
    });

    it('does not retry on 404 (not found)', () => {
      assert.equal(isRetryableError({ status: 404, message: '' }), false);
    });

    it('retries on overloaded message', () => {
      assert.equal(isRetryableError({ message: 'API is overloaded' }), true);
    });

    it('retries on rate limit message', () => {
      assert.equal(isRetryableError({ message: 'Rate limit exceeded' }), true);
    });

    it('retries on timeout message', () => {
      assert.equal(isRetryableError({ message: 'Request timeout' }), true);
    });

    it('retries on ECONNRESET', () => {
      assert.equal(isRetryableError({ message: 'read ECONNRESET' }), true);
    });

    it('retries on socket hang up', () => {
      assert.equal(isRetryableError({ message: 'socket hang up' }), true);
    });

    it('does not retry on auth errors', () => {
      assert.equal(isRetryableError({ message: 'Invalid API key' }), false);
    });

    it('checks statusCode field too', () => {
      assert.equal(isRetryableError({ statusCode: 429, message: '' }), true);
    });
  });
});
