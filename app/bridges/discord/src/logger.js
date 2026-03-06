const path = require('path');
const { createLogger } = require('../../shared/logger');

const LOG_DIR = process.env.LOG_DIR || path.join(__dirname, '..');

module.exports = createLogger('discord', {
  logDir: LOG_DIR,
});
