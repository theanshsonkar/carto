const fs = require('fs');
const path = require('path');
const { detectFramework } = require('../detector/framework');
const { parseCartoIgnore } = require('../security/ignore');
const { runSyncV2, discoverFiles: discoverFilesV2 } = require('../store/sync-v2');

async function run(projectRoot) {
  console.log('[CARTO] Detecting project...');

  const detection = detectFramework(projectRoot);
  console.log(`[CARTO] Detected: ${detection.framework} (${detection.language})`);

  // V2: discover all files without cap
  const relFiles = discoverFilesV2(projectRoot);

  const pyCount = relFiles.filter(f => f.endsWith('.py')).length;
  const jsCount = relFiles.filter(f => /\.(js|ts|jsx|tsx|mjs|cjs)$/.test(f)).length;
  const rCount = relFiles.filter(f => /\.[rR]$/.test(f)).length;
  const rsCount = relFiles.filter(f => f.endsWith('.rs')).length;
  const goCount = relFiles.filter(f => f.endsWith('.go')).length;

  const parts = [];
  if (jsCount > 0) parts.push(`${jsCount} JS/TS files`);
  if (pyCount > 0) parts.push(`${pyCount} Python files`);
  if (goCount > 0) parts.push(`${goCount} Go files`);
  if (rsCount > 0) parts.push(`${rsCount} Rust files`);
  if (rCount > 0) parts.push(`${rCount} R files`);
  console.log(`[CARTO] Found ${parts.join(', ') || '0 files'} (${relFiles.length} total)`);

  // Write .carto/config.json
  const cartoDir = path.join(projectRoot, '.carto');
  if (!fs.existsSync(cartoDir)) {
    fs.mkdirSync(cartoDir, { recursive: true });
  }

  const config = {
    version: '2',
    framework: detection.framework,
    language: detection.language,
    projectRoot: projectRoot,
    output: 'AGENTS.md',
    generated: new Date().toISOString()
  };

  fs.writeFileSync(
    path.join(cartoDir, 'config.json'),
    JSON.stringify(config, null, 2) + '\n',
    'utf-8'
  );

  // Install pre-commit hook
  installGitHook(projectRoot);

  // Run first sync — V2 SQLite-backed indexer.
  // (Previously: V1 runFullSync with empty file lists from resolveConfig — produced
  // a 23ms no-op that left .carto/carto.db missing and AGENTS.md unpopulated.)
  await runSyncV2({
    projectRoot,
    output: path.resolve(projectRoot, config.output || 'AGENTS.md')
  });

  // Auto-wire MCP config into installed AI tools
  wireIDEs(projectRoot);

  console.log('[CARTO] AGENTS.md generated. Carto will sync on every git commit.');
}

/**
 * Resolves config paths to absolute paths.
 * V2: no watch file lists — sync-v2 discovers files itself.
 */
function resolveConfig(projectRoot, config) {
  return {
    watch: {
      routeFiles: (config.watch && config.watch.routeFiles || []).map(f => path.resolve(projectRoot, f)),
      modelFiles: (config.watch && config.watch.modelFiles || []).map(f => path.resolve(projectRoot, f)),
      frontendFiles: (config.watch && config.watch.frontendFiles || []).map(f => path.resolve(projectRoot, f))
    },
    output: path.resolve(projectRoot, config.output || 'AGENTS.md'),
    projectRoot
  };
}

function installGitHook(projectRoot) {
  const gitDir = path.join(projectRoot, '.git');
  if (!fs.existsSync(gitDir)) return;

  const hooksDir = path.join(gitDir, 'hooks');
  if (!fs.existsSync(hooksDir)) fs.mkdirSync(hooksDir, { recursive: true });

  const hookPath = path.join(hooksDir, 'pre-commit');
  const hookLine = 'carto sync\n';

  if (fs.existsSync(hookPath)) {
    const existing = fs.readFileSync(hookPath, 'utf-8');
    if (existing.includes('carto sync')) {
      console.log('[CARTO] Git hook already installed.');
      return;
    }
    fs.appendFileSync(hookPath, '\n' + hookLine);
  } else {
    fs.writeFileSync(hookPath, '#!/bin/sh\n' + hookLine);
  }

  fs.chmodSync(hookPath, '755');
  console.log('[CARTO] Git pre-commit hook installed.');
}

function wireIDEs(projectRoot) {
  const os = require('os');
  const home = os.homedir();
  const wired = [];

  // Kiro
  const kiroDir = path.join(home, '.kiro', 'settings');
  if (fs.existsSync(path.join(home, '.kiro'))) {
    try {
      fs.mkdirSync(kiroDir, { recursive: true });
      const mcpPath = path.join(kiroDir, 'mcp.json');
      const config = fs.existsSync(mcpPath)
        ? JSON.parse(fs.readFileSync(mcpPath, 'utf-8'))
        : { mcpServers: {} };
      config.mcpServers = config.mcpServers || {};
      config.mcpServers.carto = { command: 'carto', args: ['serve'], cwd: projectRoot };
      fs.writeFileSync(mcpPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
      wired.push('Kiro');
    } catch {}
  }

  // Claude Desktop
  const claudeConfig = path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  if (fs.existsSync(path.dirname(claudeConfig))) {
    try {
      const config = fs.existsSync(claudeConfig)
        ? JSON.parse(fs.readFileSync(claudeConfig, 'utf-8'))
        : { mcpServers: {} };
      config.mcpServers = config.mcpServers || {};
      config.mcpServers.carto = { command: 'carto', args: ['serve'], cwd: projectRoot };
      fs.writeFileSync(claudeConfig, JSON.stringify(config, null, 2) + '\n', 'utf-8');
      wired.push('Claude Desktop');
    } catch {}
  }

  // Cursor
  const cursorConfig = path.join(home, '.cursor', 'mcp.json');
  if (fs.existsSync(path.join(home, '.cursor'))) {
    try {
      const config = fs.existsSync(cursorConfig)
        ? JSON.parse(fs.readFileSync(cursorConfig, 'utf-8'))
        : { mcpServers: {} };
      config.mcpServers = config.mcpServers || {};
      config.mcpServers.carto = { command: 'carto', args: ['serve'], cwd: projectRoot };
      fs.writeFileSync(cursorConfig, JSON.stringify(config, null, 2) + '\n', 'utf-8');
      wired.push('Cursor');
    } catch {}
  }

  if (wired.length > 0) {
    console.log(`[CARTO] MCP wired into: ${wired.join(', ')}`);
    console.log('[CARTO] Run `carto serve` to start the MCP server.');
  }
}

module.exports = { run, resolveConfig };
