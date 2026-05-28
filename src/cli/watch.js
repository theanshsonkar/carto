'use strict';

const fs = require('fs');
const path = require('path');
const { startWatcher } = require('../watcher/watch');
const { runFullSync } = require('../sync');
const { resolveConfig } = require('./init');
const { checkForUpdate } = require('./update-check');
const { loadGraphCache, saveGraphCache, buildEmptyCache } = require('../cache/graph-cache');
const { updateFileHash, removeFileHash } = require('../cache/file-hash');
const { applyIncrementalUpdate, removeFileFromGraph } = require('../engine/incremental');
const { loadLanguagePlugins, getPluginForFile } = require('../extractors/loader');
const { formatSections, formatDomainFile } = require('../agents/formatter');
const { mergeIntoAgentsMd } = require('../agents/merger');
const { validateExtracted } = require('../agents/validator');

const plugins = loadLanguagePlugins();

/**
 * writeOutputsFromCache(cache, resolved, projectRoot)
 * Writes AGENTS.md, domain context files, and map.json from the current cache state.
 * Called after every incremental update.
 */
function writeOutputsFromCache(cache, resolved, projectRoot) {
  let allRoutes = [];
  let allModels = [];
  const functionsMap = {};
  const envVarMap = new Map();
  const dbTableList = [];

  for (const [relPath, data] of Object.entries(cache.fileData)) {
    allRoutes = allRoutes.concat(data.routes);
    allModels = allModels.concat(data.models);
    if (data.functions && data.functions.length > 0) functionsMap[relPath] = data.functions;
    for (const v of (data.envVars || [])) {
      if (!envVarMap.has(v)) envVarMap.set(v, new Set());
      envVarMap.get(v).add(relPath);
    }
    for (const t of (data.dbTables || [])) {
      dbTableList.push(t.file ? t : { ...t, file: relPath });
    }
  }

  const envVars = [...envVarMap.keys()].sort().map(name => ({ name, files: [...envVarMap.get(name)].sort() }));
  const validated = validateExtracted({ routes: allRoutes, models: allModels, functions: functionsMap, envVars, dbTables: dbTableList });

  const autoContent = formatSections({
    routes: validated.routes,
    models: validated.models,
    frontend: { fetches: [], storageKeys: [] },
    structure: [],
    warnings: [],
    fileMap: [],
    functions: validated.functions,
    dbTables: validated.dbTables,
    envVars: validated.envVars,
    importGraph: cache.importGraph,
    stackItems: cache.stack || [],
    entryPoints: cache.entryPoints || [],
    highImpact: (cache.highImpact || []).map(h => ({ file: h.file, count: h.dependents }))
  });

  mergeIntoAgentsMd(resolved.output, autoContent);

  // Write domain context files
  const contextDir = path.join(projectRoot, '.carto', 'context');
  try { fs.mkdirSync(contextDir, { recursive: true }); } catch {}

  for (const [domain, cluster] of Object.entries(cache.domains || {})) {
    const hasContent = (cluster.routes || []).length > 0 ||
                       (cluster.models || []).length > 0 ||
                       Object.keys(cluster.functions || {}).length > 0 ||
                       (cluster.dbTables || []).length > 0;
    if (!hasContent) continue;
    const content = formatDomainFile(domain, cluster);
    const domainPath = path.join(contextDir, `${domain}.md`);
    const tmp = domainPath + '.tmp';
    try { fs.writeFileSync(tmp, content, 'utf-8'); fs.renameSync(tmp, domainPath); } catch {}
  }

  // Write map.json
  const cartoDir = path.join(projectRoot, '.carto');
  const mapData = {
    version: '2',
    generated: cache.generated,
    imports: cache.importGraph,
    routes: validated.routes,
    routesByFile: cache.routesByFile,
    models: validated.models,
    highImpact: cache.highImpact,
    entryPoints: cache.entryPoints,
    stack: cache.stack,
    domains: Object.keys(cache.domains || {}),
    meta: cache.meta
  };
  try {
    const tmp = path.join(cartoDir, 'map.tmp.json');
    const mapPath = path.join(cartoDir, 'map.json');
    fs.writeFileSync(tmp, JSON.stringify(mapData, null, 2) + '\n', 'utf-8');
    fs.renameSync(tmp, mapPath);
  } catch {}
}

async function run(projectRoot) {
  checkForUpdate();
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

  // Initial sync (cache-aware — only parses changed files)
  console.log('[CARTO] Starting initial sync...');
  let cache = await runFullSync(resolved);
  if (!cache) {
    cache = loadGraphCache(projectRoot) || buildEmptyCache();
  }
  console.log('[CARTO] Initial sync complete. Watching for changes...');

  const allFiles = new Set([
    ...resolved.watch.routeFiles,
    ...resolved.watch.modelFiles,
    ...resolved.watch.frontendFiles
  ]);
  const watchPaths = [...allFiles];

  // onChange: incremental update — only re-parse the 1 changed file
  const onChange = async (changedFile) => {
    const start = Date.now();
    const relPath = path.relative(projectRoot, changedFile);
    let content;
    try {
      content = fs.readFileSync(changedFile, 'utf-8');
    } catch {
      return;
    }

    const plugin = getPluginForFile(plugins, changedFile);
    if (!plugin) return;

    const extracted = plugin.extract(content, relPath);
    applyIncrementalUpdate(cache, relPath, extracted, content, projectRoot);
    cache.generated = new Date().toISOString();

    writeOutputsFromCache(cache, resolved, projectRoot);
    updateFileHash(projectRoot, relPath, content);
    saveGraphCache(projectRoot, cache);

    const elapsed = Date.now() - start;
    console.log(`[CARTO] ${path.basename(changedFile)} → re-indexed in ${elapsed}ms`);
  };

  // onAdd: treat new files as changed
  const onAdd = async (filePath) => {
    await onChange(filePath);
    console.log(`[CARTO] New file detected: ${path.relative(projectRoot, filePath)}`);
  };

  // onRemove: remove from graph
  const onRemove = async (filePath) => {
    const relPath = path.relative(projectRoot, filePath);
    removeFileFromGraph(cache, relPath);
    writeOutputsFromCache(cache, resolved, projectRoot);
    removeFileHash(projectRoot, relPath);
    saveGraphCache(projectRoot, cache);
    console.log(`[CARTO] Removed: ${relPath}`);
  };

  startWatcher(watchPaths, onChange, onAdd, onRemove);

  console.log('[CARTO] Watching files (incremental mode):');
  for (const p of watchPaths) console.log(`  → ${p}`);
  console.log(`  → Output: ${resolved.output}`);
}

module.exports = { run };
