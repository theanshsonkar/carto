const path = require('path');
const fs = require('fs');

function run(projectRoot) {
  // Prefer V2 SQLite-backed server
  const dbPath = path.join(projectRoot, '.carto', 'carto.db');
  if (fs.existsSync(dbPath)) {
    console.error('[CARTO] MCP server starting (V2 SQLite)...');
    require('../mcp/server-v2');
    return;
  }

  // Fallback to V1 if no SQLite DB exists
  const mapPath = path.join(projectRoot, '.carto', 'map.json');
  if (!fs.existsSync(mapPath)) {
    console.error('[CARTO] No index found. Run `carto sync` first.');
    process.exit(1);
  }
  console.error('[CARTO] MCP server starting (V1 compat)...');
  require('../mcp/server');
}

module.exports = { run };
