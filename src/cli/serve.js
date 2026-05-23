const path = require('path');
const fs = require('fs');

function run(projectRoot) {
  const mapPath = path.join(projectRoot, '.carto', 'map.json');
  if (!fs.existsSync(mapPath)) {
    console.error('[CARTO] No .carto/map.json found. Run `carto init` first.');
    process.exit(1);
  }
  console.error('[CARTO] MCP server starting...');
  require('../mcp/server');
}

module.exports = { run };
