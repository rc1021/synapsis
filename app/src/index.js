const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const log = require('./logger');
const { registerBridge } = require('../scheduler/src/notifier');
const securityMonitor = require('../bridges/shared/security-monitor');

const channels = [
  require('../bridges/web/src/index'),
  require('../scheduler/src/index'),
  require('../bridges/discord/src/index'),
  // require('../bridges/telegram/src/index'),  // future
];

let shuttingDown = false;

async function main() {
  log.info('synapsis starting...');

  for (const ch of channels) {
    await ch.start();
    log.info(`[${ch.name}] started`);

    // Register bridges that support sendDM with the notifier + security monitor
    if (typeof ch.sendDM === 'function') {
      registerBridge(ch.name, ch);
      securityMonitor.init({
        adminId: process.env.SECURITY_ADMIN_ID,
        sendDM: ch.sendDM,
      });
    }
  }

  log.info('synapsis fully started');
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`Received ${signal}, shutting down...`);

  for (const ch of channels.reverse()) {
    await ch.cleanup();
  }

  log.info('synapsis stopped');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

main().catch(err => {
  log.error('Fatal error during startup:', err.message);
  process.exit(1);
});
