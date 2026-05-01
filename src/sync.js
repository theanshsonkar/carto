const fs = require('fs');
const path = require('path');
const { loadLanguagePlugins, getPluginForFile } = require('./extractors/loader');
const { formatSections } = require('./agents/formatter');
const { mergeIntoAgentsMd } = require('./agents/merger');
const { inferResponsibility } = require('./extractors/filemap');
const { validateExtracted } = require('./agents/validator');

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
  const envVarMap = {};
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
    const plugin = getPluginForFile(plugins, filePath);

    if (!plugin) {
      // No plugin for this file type — skip silently
      continue;
    }

    const result = plugin.extract(content, basename);

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
      if (!envVarMap[varName]) envVarMap[varName] = new Set();
      envVarMap[varName].add(basename);
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

  // Build file map
  const fileMap = [];
  for (const filePath of allCodeFiles) {
    const basename = path.basename(filePath);
    const funcCount = (functionsMap[basename] || []).length;
    const routeCount = routeCountMap[filePath] || 0;
    const responsibility = inferResponsibility(basename, funcCount, routeCount);
    if (responsibility && responsibility !== '\u2014') {
      fileMap.push({ file: basename, responsibility });
    }
  }

  // Aggregate env vars into sorted array
  const envVars = Object.keys(envVarMap)
    .sort()
    .map(name => ({ name, files: [...envVarMap[name]].sort() }));

  // Scan project structure
  const structure = await scanStructure(config.projectRoot);

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
    envVars: validated.envVars
  });

  mergeIntoAgentsMd(config.output, autoContent);
}

module.exports = { runFullSync, safeReadFile, scanStructure };
