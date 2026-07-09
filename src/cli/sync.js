const fs = require('fs');
const path = require('path');
const { runSync } = require('../store/sync');
const { checkForUpdate } = require('./update-check');

async function run(projectRoot) {
  checkForUpdate(); // fire and forget
  const configPath = path.join(projectRoot, '.carto', 'config.json');
  const dbPath = path.join(projectRoot, '.carto', 'carto.db');

  let config;
  if (!fs.existsSync(configPath)) {
    // A container built via the programmatic API (StoreAdapter.index) has a
    // valid carto.db + bitmap but no config.json — the file is only written
    // by `carto init`. Rather than refuse (CARTO-005), self-heal: if an
    // index exists, reconstruct a minimal config so every CLI subcommand
    // works off any built DB. Only truly-uninitialized repos are rejected.
    if (!fs.existsSync(dbPath)) {
      console.error('[CARTO] Run "carto init" first.');
      process.exit(1);
    }
    let detection = { framework: 'unknown', language: 'unknown' };
    try { detection = require('../detector/framework').detectFramework(projectRoot); } catch { /* keep defaults */ }
    config = {
      version: '2',
      framework: detection.framework,
      language: detection.language,
      projectRoot,
      output: 'AGENTS.md',
      generated: new Date().toISOString(),
      selfHealed: true,
    };
    try {
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
      console.log('[CARTO] Recovered missing .carto/config.json from the existing index.');
    } catch (err) {
      console.error(`[CARTO] Could not write .carto/config.json: ${err.message}`);
      process.exit(1);
    }
  } else {
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch (err) {
      console.error(`[CARTO] Error reading .carto/config.json: ${err.message}`);
      process.exit(1);
    }
  }

  await runSync({
    projectRoot,
    output: path.resolve(projectRoot, config.output || 'AGENTS.md')
  });

  console.log('[CARTO] Sync complete.');
}

module.exports = { run };
