const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = __dirname;

/**
 * Load all migration files, sorted by semver.
 * Returns [{ version: '1.1.0', migrate: fn }, ...]
 */
function loadMigrations() {
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => /^\d+\.\d+\.\d+\.js$/.test(f))
    .sort(compareSemver);

  return files.map(f => ({
    version: f.replace('.js', ''),
    migrate: require(path.join(MIGRATIONS_DIR, f)),
  }));
}

/**
 * Get migrations that need to run for a given workspace version.
 */
function getPendingMigrations(currentVersion) {
  return loadMigrations().filter(m => compareSemver(m.version, currentVersion) > 0);
}

/**
 * Compare two semver strings. Returns -1, 0, or 1.
 */
function compareSemver(a, b) {
  // Handle filenames (strip .js)
  const va = String(a).replace('.js', '').split('.').map(Number);
  const vb = String(b).replace('.js', '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((va[i] || 0) < (vb[i] || 0)) return -1;
    if ((va[i] || 0) > (vb[i] || 0)) return 1;
  }
  return 0;
}

module.exports = { getPendingMigrations, compareSemver };
