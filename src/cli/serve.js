const path = require('path');
const fs = require('fs');
const { checkForUpdate } = require('./update-check');

function run(projectRoot) {
  checkForUpdate(); // fire and forget
  const dbPath = path.join(projectRoot, '.carto', 'carto.db');

  if (!fs.existsSync(dbPath)) {
    // Could be pre-2.0.4 install with only map.json, or never initialized.
    const mapPath = path.join(projectRoot, '.carto', 'map.json');
    if (fs.existsSync(mapPath)) {
      console.error('[CARTO] Legacy index found (map.json) but no SQLite DB. Run `carto init` to upgrade your index.');
    } else {
      console.error('[CARTO] No index found. Run `carto init` first.');
    }
    process.exit(1);
  }

  console.error('[CARTO] MCP server starting...');
  require('../mcp/server-v2');
}

module.exports = { run };
