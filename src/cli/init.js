const fs = require('fs');
const path = require('path');
const { detectFramework } = require('../detector/framework');
const { discoverFiles } = require('../detector/files');
const { parseCartoIgnore } = require('../security/ignore');
const { runFullSync } = require('../sync');

async function run(projectRoot) {
  console.log('[CARTO] Detecting project...');

  const detection = detectFramework(projectRoot);
  console.log(`[CARTO] Detected: ${detection.framework} (${detection.language})`);

  const isIgnored = parseCartoIgnore(projectRoot);
  const files = discoverFiles(projectRoot, detection.framework, isIgnored, detection.secondaryFramework);

  // Count files for reporting
  const pyCount = files.routeFiles.filter(f => f.endsWith('.py')).length;
  const jsCount = files.routeFiles.filter(f => /\.(js|ts|jsx|tsx)$/.test(f)).length;
  const htmlCount = files.frontendFiles.length;

  const parts = [];
  if (pyCount > 0) parts.push(`${pyCount} Python files`);
  if (jsCount > 0) parts.push(`${jsCount} JS/TS files`);
  if (htmlCount > 0) parts.push(`${htmlCount} HTML files`);
  console.log(`[CARTO] Found ${parts.join(', ') || '0 files'}`);

  // Make paths relative for config storage
  const relRouteFiles = files.routeFiles.map(f => path.relative(projectRoot, f));
  const relModelFiles = files.modelFiles.map(f => path.relative(projectRoot, f));
  const relFrontendFiles = files.frontendFiles.map(f => path.relative(projectRoot, f));

  // Write .carto/config.json
  const cartoDir = path.join(projectRoot, '.carto');
  if (!fs.existsSync(cartoDir)) {
    fs.mkdirSync(cartoDir, { recursive: true });
  }

  const config = {
    version: '1',
    framework: detection.framework,
    language: detection.language,
    watch: {
      routeFiles: relRouteFiles,
      modelFiles: relModelFiles,
      frontendFiles: relFrontendFiles
    },
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

  // Run first sync
  const syncConfig = resolveConfig(projectRoot, config);
  await runFullSync(syncConfig);

  console.log('[CARTO] AGENTS.md generated. Carto will sync on every git commit.');
}

/**
 * Resolves relative paths in config to absolute paths.
 */
function resolveConfig(projectRoot, config) {
  return {
    watch: {
      routeFiles: (config.watch.routeFiles || []).map(f => path.resolve(projectRoot, f)),
      modelFiles: (config.watch.modelFiles || []).map(f => path.resolve(projectRoot, f)),
      frontendFiles: (config.watch.frontendFiles || []).map(f => path.resolve(projectRoot, f))
    },
    output: path.resolve(projectRoot, config.output),
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

module.exports = { run, resolveConfig };
