const fs = require('fs');
const path = require('path');
const { startWatcher } = require('../watcher/watch');
const { runFullSync } = require('../sync');
const { resolveConfig } = require('./init');

async function run(projectRoot) {
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

  const resolved = resolveConfig(projectRoot, config);

  // Run full sync once on startup
  console.log('[CARTO] Starting initial sync...');
  await runFullSync(resolved);
  console.log('[CARTO] Initial sync complete');

  // Collect all watch paths (deduplicated)
  const allFiles = new Set([
    ...resolved.watch.routeFiles,
    ...resolved.watch.modelFiles,
    ...resolved.watch.frontendFiles
  ]);
  const watchPaths = [...allFiles];

  startWatcher(watchPaths, async (changedFile) => {
    await runFullSync(resolved);
    const timestamp = new Date().toISOString();
    const filename = path.basename(changedFile);
    console.log(`[CARTO] ${filename} updated → AGENTS.md synced — ${timestamp}`);
  });

  console.log('[CARTO] Watching files...');
  for (const p of watchPaths) {
    console.log(`  → ${p}`);
  }
  console.log(`  → Output: ${resolved.output}`);
}

module.exports = { run };
