'use strict';

/**
 * Persistent ACP provider config — last-used providerId + baseUrl + model.
 *
 * NEVER persists `apiKey`. Keys come from environment or IDE settings each
 * time `carto agent` starts. Carto refuses to write a key to disk even if
 * the caller asks; the config file is open to all editors.
 *
 * File: `.carto/agent-config.json`
 * Shape: { providerId: string, baseUrl?: string, model?: string }
 */

const fs = require('fs');
const path = require('path');

const CONFIG_FILENAME = 'agent-config.json';

function configPath(projectRoot) {
  return path.join(projectRoot, '.carto', CONFIG_FILENAME);
}

function loadAgentConfig(projectRoot) {
  const p = configPath(projectRoot);
  if (!fs.existsSync(p)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
    if (!raw || typeof raw !== 'object') return null;
    return {
      providerId: typeof raw.providerId === 'string' ? raw.providerId : null,
      baseUrl: typeof raw.baseUrl === 'string' ? raw.baseUrl : null,
      model: typeof raw.model === 'string' ? raw.model : null,
    };
  } catch {
    return null;
  }
}

/**
 * saveAgentConfig({ projectRoot, providerId, baseUrl?, model? })
 *
 * Strips any `apiKey`/`key`/`token`/`secret`-like field defensively, even
 * if a future caller passes one. The persisted file is shape-validated
 * and won't contain those fields under any circumstances.
 */
function saveAgentConfig({ projectRoot, providerId, baseUrl = null, model = null }) {
  if (!projectRoot || !providerId) return null;
  const cartoDir = path.join(projectRoot, '.carto');
  try { fs.mkdirSync(cartoDir, { recursive: true }); } catch {}
  const safe = { providerId, baseUrl, model };
  // Belt-and-suspenders strip
  delete safe.apiKey;
  delete safe.key;
  delete safe.token;
  delete safe.secret;
  fs.writeFileSync(configPath(projectRoot), JSON.stringify(safe, null, 2), 'utf-8');
  return safe;
}

function clearAgentConfig(projectRoot) {
  try { fs.unlinkSync(configPath(projectRoot)); } catch {}
}

module.exports = { loadAgentConfig, saveAgentConfig, clearAgentConfig, configPath, CONFIG_FILENAME };
