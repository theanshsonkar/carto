const fs = require('fs');
const path = require('path');
const { loadLanguagePlugins, getPluginForFile } = require('./extractors/loader');
const { formatSections } = require('./agents/formatter');
const { mergeIntoAgentsMd } = require('./agents/merger');
const { inferResponsibility } = require('./extractors/filemap');
const { validateExtracted } = require('./agents/validator');
const { buildImportGraph } = require('./extractors/imports');
const { buildStackLine } = require('./extractors/stack');

const IGNORE_DIRS = new Set(['node_modules', '.git', '__pycache__', '.venv', 'venv', '.idea', '.vscode', '.carto', 'AGENTS.md']);

// Load plugins once at module load
const plugins = loadLanguagePlugins();

/**
 * Safe file read — returns null on error and pushes a warning.
 */
async function safeReadFile(filePath, warnings) {
  try {
    return await fs.promises.readFile(filePath, 'utf-8');
  } catch (err) {
    warnings.push(`Could not read ${filePath} — ${err.code || err.message}`);
    console.warn(`[CARTO] Warning: Could not read ${filePath} — skipping`);
    return null;
  }
}

/**
 * Scans top-level folder structure (1 level deep).
 * Ignores node_modules, .git, __pycache__, etc.
 */
async function scanStructure(basePath) {
  const entries = [];
  try {
    const items = await fs.promises.readdir(basePath, { withFileTypes: true });
    for (const item of items) {
      if (IGNORE_DIRS.has(item.name)) continue;
      entries.push({
        name: item.name,
        type: item.isDirectory() ? 'dir' : 'file'
      });
    }
    entries.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  } catch (err) {
    console.warn(`[CARTO] Warning: Could not scan ${basePath} — skipping structure`);
  }
  return entries;
}

/**
 * runFullSync(config) — reads all source files, extracts data, writes AGENTS.md.
 */
async function runFullSync(config) {
  const warnings = [];
  const projectRoot = config.projectRoot || process.cwd();

  const allRouteFiles = config.watch.routeFiles || [];
  const allModelFiles = config.watch.modelFiles || [];
  const allFrontendFiles = config.watch.frontendFiles || [];

  // Aggregate data
  let allRoutes = [];
  let allModels = [];
  let allFetches = [];
  let allStorageKeys = [];

  // Functions: { filename: [{ name, params, returnType }] }
  const functionsMap = {};
  // Routes per file for file map
  const routeCountMap = {};
  // Env vars: { varName: Set([filename, ...]) }
  const envVarMap = new Map();
  // DB tables: [{ tableName, modelName, file }]
  const dbTableList = [];

  // Deduplicate files
  const processedFiles = new Set();

  // Process all code files (route + model files, deduplicated)
  const allCodeFiles = [...new Set([...allRouteFiles, ...allModelFiles])];

  for (const filePath of allCodeFiles) {
    if (processedFiles.has(filePath)) continue;
    processedFiles.add(filePath);

    const content = await safeReadFile(filePath, warnings);
    if (!content) continue;

    const basename = path.basename(filePath);
    const relPath = path.relative(projectRoot, filePath);
    const plugin = getPluginForFile(plugins, filePath);

    if (!plugin) {
      // No plugin for this file type — skip silently
      continue;
    }

    const result = plugin.extract(content, relPath);

    // Routes
    allRoutes = allRoutes.concat(result.routes);
    routeCountMap[filePath] = result.routes.length;

    // Models
    allModels = allModels.concat(result.models);

    // Functions
    if (result.functions.length > 0 && basename !== '__init__.py') {
      functionsMap[basename] = result.functions;
    }

    // Env vars
    for (const varName of result.envVars) {
      if (!envVarMap.has(varName)) envVarMap.set(varName, new Set());
      envVarMap.get(varName).add(basename);
    }

    // DB tables
    for (const t of result.dbTables) {
      dbTableList.push({ tableName: t.tableName, modelName: t.modelName, file: basename });
    }

    // Fetches and storage keys (from JS/HTML plugins)
    allFetches = allFetches.concat(result.fetches);
    allStorageKeys = allStorageKeys.concat(result.storageKeys);
  }

  // Process frontend files separately (may overlap with code files)
  for (const filePath of allFrontendFiles) {
    if (processedFiles.has(filePath)) continue;
    processedFiles.add(filePath);

    const content = await safeReadFile(filePath, warnings);
    if (!content) continue;

    const basename = path.basename(filePath);
    const plugin = getPluginForFile(plugins, filePath);

    if (!plugin) continue;

    const result = plugin.extract(content, basename);
    allFetches = allFetches.concat(result.fetches);
    allStorageKeys = allStorageKeys.concat(result.storageKeys);
  }

  // Global dedup: collapse dynamic fetches across all files into one summary row
  const staticFetches = allFetches.filter(f => f.url !== '[dynamic]' && !f.url.startsWith('dynamic calls detected'));
  let totalDynamic = 0;
  for (const f of allFetches) {
    if (f.url === '[dynamic]') totalDynamic++;
    // Also count already-collapsed per-file rows
    const m = f.url.match(/^dynamic calls detected \((\d+) unresolved\)$/);
    if (m) totalDynamic += parseInt(m[1], 10);
  }
  if (totalDynamic > 0) {
    staticFetches.push({ url: `dynamic calls detected (${totalDynamic} unresolved)`, method: '\u2014' });
  }
  allFetches = staticFetches;

  // Global dedup: storage keys across all files
  const skSeen = new Set();
  allStorageKeys = allStorageKeys.filter(({ operation, key }) => {
    const id = `${operation}::${key}`;
    if (skSeen.has(id)) return false;
    skSeen.add(id);
    return true;
  });

  // Build import graph from all processed files
  const fileContentsForImports = [];
  const allProcessedPaths = [...new Set([...allCodeFiles, ...allFrontendFiles])];
  // Re-read is avoided — collect during processing. Use a second pass for simplicity.
  for (const filePath of allProcessedPaths) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      fileContentsForImports.push({ filePath, content });
    } catch {
      // skip — already warned during extraction
    }
  }
  const importGraph = buildImportGraph(fileContentsForImports, projectRoot);

  // Detect tech stack from watched files + manifests
  const stackItems = buildStackLine(fileContentsForImports, projectRoot);

  // Compute entry points and high impact files from import graph
  const allValues = new Set();
  for (const deps of Object.values(importGraph)) {
    for (const dep of deps) allValues.add(dep);
  }
  // Entry points: files that import 3+ others but nothing imports them
  const entryPoints = Object.keys(importGraph)
    .filter(f => !allValues.has(f) && importGraph[f].length >= 3)
    .sort();
  // High impact: files imported by 3+ others, sorted descending by count
  const depCount = {};
  for (const deps of Object.values(importGraph)) {
    for (const dep of deps) {
      depCount[dep] = (depCount[dep] || 0) + 1;
    }
  }
  const highImpact = Object.entries(depCount)
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .map(([file, count]) => ({ file, count }));

  // Build file map
  const fileMap = [];
  for (const filePath of allCodeFiles) {
    const basename = path.basename(filePath);
    const relPath = path.relative(projectRoot, filePath);
    const funcCount = (functionsMap[basename] || []).length;
    const routeCount = routeCountMap[filePath] || 0;
    const responsibility = inferResponsibility(basename, funcCount, routeCount);
    if (responsibility && responsibility !== '\u2014') {
      fileMap.push({ file: relPath, responsibility });
    }
  }

  // Aggregate env vars into sorted array
  const envVars = [...envVarMap.keys()]
    .sort()
    .map(name => ({ name, files: [...envVarMap.get(name)].sort() }));

  // Scan project structure
  const structure = await scanStructure(projectRoot);

  // Validate extracted data — drop anything malformed
  const validated = validateExtracted({
    routes: allRoutes,
    models: allModels,
    functions: functionsMap,
    envVars,
    dbTables: dbTableList
  });

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
    importGraph,
    stackItems,
    entryPoints,
    highImpact
  });

  mergeIntoAgentsMd(config.output, autoContent);

  // Save graph to .carto/map.json (atomic write)
  const cartoDir = path.join(projectRoot, '.carto');
  const mapData = {
    version: '1',
    generated: new Date().toISOString(),
    imports: importGraph,
    routes: validated.routes,
    highImpact: highImpact.map(h => ({ file: h.file, dependents: h.count })),
    entryPoints,
    stack: stackItems
  };
  try {
    const tmpPath = path.join(cartoDir, 'map.tmp.json');
    const mapPath = path.join(cartoDir, 'map.json');
    fs.writeFileSync(tmpPath, JSON.stringify(mapData, null, 2) + '\n', 'utf-8');
    fs.renameSync(tmpPath, mapPath);
  } catch (err) {
    console.warn(`[CARTO] Warning: Could not write .carto/map.json — ${err.message}`);
  }
}

module.exports = { runFullSync, safeReadFile, scanStructure };
