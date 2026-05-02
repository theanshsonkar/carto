const fs = require('fs');
const path = require('path');

function run(projectRoot) {
  const agentsPath = path.join(projectRoot, 'AGENTS.md');
  const cartoDir = path.join(projectRoot, '.carto');

  const agentsExists = fs.existsSync(agentsPath);
  const cartoDirExists = fs.existsSync(cartoDir);

  if (!agentsExists && !cartoDirExists) {
    console.log('[CARTO] Nothing to remove — Carto is not initialized in this project.');
    return;
  }

  if (agentsExists) {
    try {
      fs.unlinkSync(agentsPath);
      console.log('[CARTO] Removed AGENTS.md');
    } catch (err) {
      console.error(`[CARTO] Failed to remove AGENTS.md: ${err.message}`);
    }
  }

  if (cartoDirExists) {
    try {
      fs.rmSync(cartoDir, { recursive: true, force: true });
      console.log('[CARTO] Removed .carto/');
    } catch (err) {
      console.error(`[CARTO] Failed to remove .carto/: ${err.message}`);
    }
  }

  console.log('[CARTO] Carto removed from this project.');
}

module.exports = { run };
