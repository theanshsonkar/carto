const fs = require('fs');
const path = require('path');
const { runSyncV2 } = require('../store/sync-v2');
const { runFullSync } = require('../sync');
const { resolveConfig } = require('./init');
const { checkForUpdate } = require('./update-check');

async function run(projectRoot) {
  checkForUpdate(); // fire and forget
  const configPath = path.join(projectRoot, '.carto', 'config.json');

  if (!fs.existsSync(configPath)) {
    console.error('[CARTO] Run "carto init" first.');
    process.exit(1);
  }

  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch (err) {
    console.error(`[CARTO] Error reading .carto/config.json: ${err.message}`);
    process.exit(1);
  }

  // Use V2 SQLite-backed sync
  const v2Config = {
    projectRoot,
    output: path.resolve(projectRoot, config.output || 'AGENTS.md')
  };

  try {
    await runSyncV2(v2Config);
  } catch (err) {
    // Fallback to V1 if V2 fails (e.g., better-sqlite3 not available)
    console.warn(`[CARTO] V2 sync failed (${err.message}), falling back to V1`);
    const resolved = resolveConfig(projectRoot, config);
    await runFullSync(resolved);
  }

  console.log('[CARTO] Sync complete.');
}

module.exports = { run };
