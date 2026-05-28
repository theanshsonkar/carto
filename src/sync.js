'use strict';

const fs = require('fs');
const path = require('path');
const { loadLanguagePlugins, getPluginForFile } = require('./extractors/loader');
const { formatSections, formatDomainFile } = require('./agents/formatter');
const { clusterByDomain } = require('./agents/domains');
const { mergeIntoAgentsMd } = require('./agents/merger');
const { inferResponsibility } = require('./extractors/filemap');
const { validateExtracted } = require('./agents/validator');
const { buildImportGraph } = require('./extractors/imports');
const { buildStackLine } = require('./extractors/stack');
const { loadHashes, saveHashes, computeChangedFiles } = require('./cache/file-hash');
const { loadGraphCache, saveGraphCache, buildEmptyCache } = require('./cache/graph-cache');
const { applyIncrementalUpdate, recomputeGraphMetrics } = require('./engine/incremental');

const IGNORE_DIRS = new Set(['node_modules', '.git', '__pycache__', '.venv', 'venv', '.idea', '.vscode', '.carto', 'AGENTS.md']);

// Load plugins once at module load
const plugins = loadLanguagePlugins();

async function safeReadFile(filePath, warnings) {
  try {
    return await fs.promises.readFile(filePath, 'utf-8');
  } catch (err) {
    if (warnings) warnings.push(`Could not read ${filePath} — ${err.code || err.message}`);
    console.warn(`[CARTO] Warning: Could not read ${filePath} — skipping`);
    return null;
  }
}

async function scanStructure(basePath) {
  const entries = [];
  try {
    const items = await fs.promises.readdir(basePath, { withFileTypes: true });
    for (const item of items) {
      if (IGNORE_DIRS.has(item.name)) continue;
      entries.push({ name: item.name, type: item.isDirectory() ? 'dir' : 'file' });
    }
    entries.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  } catch {}
  return entries;
}

/**
 * runFullSync(config)
 *
 * Cache-aware full sync:
 * 1. Load stored file hashes + graph cache
 * 2. Only re-parse files whose hash changed (or new files)
 * 3. Use cached data for unchanged files
 * 4. Save updated hashes + graph cache
 */
async function runFullSync(config) {
  const startTime = Date.now();
  const warnings = [];
  const projectRoot = config.projectRoot || process.cwd();

  const allRouteFiles = config.watch.routeFiles || [];
  const allModelFiles = config.watch.modelFiles || [];
  const allFrontendFiles = config.watch.frontendFiles || [];
  const allCodeFiles = [...new Set([...allRouteFiles, ...allModelFiles])];
  const allProcessedPaths = [...new Set([...allCodeFiles, ...allFrontendFiles])];

  // Load existing hashes and graph cache
  const storedHashes = loadHashes(projectRoot);
  const existingCache = loadGraphCache(projectRoot) || buildEmptyCache();

  // Determine which files actually changed
  const { changed, hashes: newHashes } = computeChangedFiles(allProcessedPaths, storedHashes, projectRoot);
  const changedSet = new Set(changed.map(f => path.relative(projectRoot, f)));

  const cacheHit = allProcessedPaths.length - changed.length;
  if (cacheHit > 0) {
    console.log(`[CARTO] Cache: ${cacheHit} files unchanged, ${changed.length} to re-parse`);
  }

  // Build a working cache — start from existing, overwrite changed files
  const cache = existingCache;

  // Remove stale data for files that no longer exist
  const currentRelPaths = new Set(allProcessedPaths.map(f => path.relative(projectRoot, f)));
  for (const relPath of Object.keys(cache.fileData)) {
    if (!currentRelPaths.has(relPath)) {
      delete cache.fileData[relPath];
      delete cache.importGraph[relPath];
      delete cache.routesByFile[relPath];
    }
  }

  // Parse only changed files
  const processedFiles = new Set();

  for (const filePath of allCodeFiles) {
    if (processedFiles.has(filePath)) continue;
    processedFiles.add(filePath);

    const relPath = path.relative(projectRoot, filePath);

    // Skip if file unchanged and we have cached data
    if (!changedSet.has(relPath) && cache.fileData[relPath]) continue;

    const content = await safeReadFile(filePath, warnings);
    if (!content) continue;

    const plugin = getPluginForFile(plugins, filePath);
    if (!plugin) continue;

    const result = plugin.extract(content, relPath);

    cache.fileData[relPath] = {
      routes: result.routes || [],
      models: result.models || [],
      functions: result.functions || [],
      envVars: result.envVars || [],
      dbTables: (result.dbTables || []).map(t => ({ ...t, file: relPath })),
      fetches: result.fetches || [],
      storageKeys: result.storageKeys || [],
    };

    if (result.routes && result.routes.length > 0) {
      cache.routesByFile[relPath] = result.routes.map(r => `${r.method} ${r.path}`);
    } else {
      delete cache.routesByFile[relPath];
    }
  }

  for (const filePath of allFrontendFiles) {
    if (processedFiles.has(filePath)) continue;
    processedFiles.add(filePath);

    const relPath = path.relative(projectRoot, filePath);
    if (!changedSet.has(relPath) && cache.fileData[relPath]) continue;

    const content = await safeReadFile(filePath, warnings);
    if (!content) continue;

    const plugin = getPluginForFile(plugins, filePath);
    if (!plugin) continue;

    const result = plugin.extract(content, path.basename(filePath));
    cache.fileData[relPath] = {
      routes: [],
      models: [],
      functions: [],
      envVars: [],
      dbTables: [],
      fetches: result.fetches || [],
      storageKeys: result.storageKeys || [],
    };
  }

  // Rebuild import graph only for changed files; keep rest from cache
  const fileContentsForImports = [];
  for (const filePath of allProcessedPaths) {
    const relPath = path.relative(projectRoot, filePath);
    // Only re-read changed files for import extraction
    if (!changedSet.has(relPath) && cache.importGraph[relPath] !== undefined) continue;
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      fileContentsForImports.push({ filePath, content });
    } catch {}
  }

  if (fileContentsForImports.length > 0) {
    const deltaGraph = buildImportGraph(fileContentsForImports, projectRoot);
    for (const [relPath, deps] of Object.entries(deltaGraph)) {
      cache.importGraph[relPath] = deps;
    }
  }

  // Stack detection only from changed files
  if (changed.length > 0) {
    const changedContents = [];
    for (const filePath of changed) {
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        changedContents.push({ filePath, content });
      } catch {}
    }
    if (changedContents.length > 0) {
      cache.stack = buildStackLine(changedContents, projectRoot);
    }
  }

  // Recompute graph metrics (highImpact, entryPoints, domains)
  recomputeGraphMetrics(cache);
  cache.meta.indexDuration = Date.now() - startTime;
  cache.meta.lastIndexed = new Date().toISOString();
  cache.generated = new Date().toISOString();

  // --- Assemble aggregated data for output ---
  let allRoutes = [];
  let allModels = [];
  let allFetches = [];
  let allStorageKeys = [];
  const functionsMap = {};
  const routeCountMap = {};
  const envVarMap = new Map();
  const dbTableList = [];

  for (const [relPath, data] of Object.entries(cache.fileData)) {
    allRoutes = allRoutes.concat(data.routes);
    allModels = allModels.concat(data.models);

    if (data.routes.length > 0) routeCountMap[relPath] = data.routes.length;
    if (data.functions && data.functions.length > 0) {
      const basename = path.basename(relPath);
      if (basename !== '__init__.py') functionsMap[relPath] = data.functions;
    }
    for (const varName of data.envVars) {
      if (!envVarMap.has(varName)) envVarMap.set(varName, new Set());
      envVarMap.get(varName).add(relPath);
    }
    for (const t of data.dbTables) {
      dbTableList.push(t.file ? t : { ...t, file: relPath });
    }
    allFetches = allFetches.concat(data.fetches || []);
    allStorageKeys = allStorageKeys.concat(data.storageKeys || []);
  }

  // Deduplicate fetches
  const staticFetches = allFetches.filter(f => f.url !== '[dynamic]' && !f.url.startsWith('dynamic calls detected'));
  let totalDynamic = 0;
  for (const f of allFetches) {
    if (f.url === '[dynamic]') totalDynamic++;
    const m = f.url.match(/^dynamic calls detected \((\d+) unresolved\)$/);
    if (m) totalDynamic += parseInt(m[1], 10);
  }
  if (totalDynamic > 0) staticFetches.push({ url: `dynamic calls detected (${totalDynamic} unresolved)`, method: '—' });
  allFetches = staticFetches;

  const skSeen = new Set();
  allStorageKeys = allStorageKeys.filter(({ operation, key }) => {
    const id = `${operation}::${key}`;
    if (skSeen.has(id)) return false;
    skSeen.add(id);
    return true;
  });

  const envVars = [...envVarMap.keys()].sort().map(name => ({ name, files: [...envVarMap.get(name)].sort() }));

  const fileMap = [];
  for (const [relPath, data] of Object.entries(cache.fileData)) {
    const funcCount = (data.functions || []).length;
    const routeCount = data.routes.length;
    const responsibility = inferResponsibility(path.basename(relPath), funcCount, routeCount);
    if (responsibility && responsibility !== '—') fileMap.push({ file: relPath, responsibility });
  }

  const structure = await scanStructure(projectRoot);

  const validated = validateExtracted({ routes: allRoutes, models: allModels, functions: functionsMap, envVars, dbTables: dbTableList });

  const autoContent = formatSections({
    routes: validated.routes,
    models: validated.models,
    frontend: { fetches: allFetches, storageKeys: allStorageKeys },
    structure,
    warnings,
    fileMap,
    functions: validated.functions,
    dbTables: validated.dbTables,
    envVars: validated.envVars,
    importGraph: cache.importGraph,
    stackItems: cache.stack,
    entryPoints: cache.entryPoints,
    highImpact: cache.highImpact.map(h => ({ file: h.file, count: h.dependents }))
  });

  mergeIntoAgentsMd(config.output, autoContent);

  // Write domain context files
  const contextDir = path.join(projectRoot, '.carto', 'context');
  try { fs.mkdirSync(contextDir, { recursive: true }); } catch {}

  for (const [domain, cluster] of Object.entries(cache.domains || {})) {
    const hasContent = (cluster.routes || []).length > 0 ||
                       (cluster.models || []).length > 0 ||
                       Object.keys(cluster.functions || {}).length > 0 ||
                       (cluster.dbTables || []).length > 0;
    if (!hasContent) continue;

    const domainContent = formatDomainFile(domain, cluster);
    const domainPath = path.join(contextDir, `${domain}.md`);
    const tmpPath = domainPath + '.tmp';
    try {
      fs.writeFileSync(tmpPath, domainContent, 'utf-8');
      fs.renameSync(tmpPath, domainPath);
    } catch (err) {
      console.warn(`[CARTO] Warning: Could not write ${domain}.md — ${err.message}`);
    }
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
  } catch (err) {
    console.warn(`[CARTO] Warning: Could not write .carto/map.json — ${err.message}`);
  }

  // Persist hash cache and graph cache
  saveHashes(projectRoot, newHashes);
  saveGraphCache(projectRoot, cache);

  const elapsed = Date.now() - startTime;
  const total = allProcessedPaths.length;
  const skipped = total - changed.length;
  console.log(`[CARTO] Indexed ${changed.length} files (${skipped} cached) in ${elapsed}ms`);

  return cache;
}

module.exports = { runFullSync, safeReadFile, scanStructure };
