const path = require('path');
const { createLogger } = require('../../bridges/shared/logger');

module.exports = createLogger('scheduler', {
  logDir: path.join(__dirname, '..', 'logs'),
});
