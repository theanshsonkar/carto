const fs = require('fs');
const path = require('path');
const { runSync } = require('../store/sync');
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

  await runSync({
    projectRoot,
    output: path.resolve(projectRoot, config.output || 'AGENTS.md')
  });

  console.log('[CARTO] Sync complete.');
}

module.exports = { run };
