'use strict';

const { startAgent } = require('../acp/agent');

/**
 * `carto agent` — Starts Carto in ACP mode (stdin/stdout).
 * Editors like Zed and JetBrains spawn this as a subprocess.
 */
function run() {
  startAgent();
}

module.exports = { run };
