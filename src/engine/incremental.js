'use strict';

const path = require('path');
const { extractImports, buildImportGraph } = require('../extractors/imports');
const { clusterByDomain } = require('../agents/domains');

/**
 * removeFileFromCache(cache, relPath)
 * Strips all data for a file from the cache before re-inserting updated data.
 */
function removeFileFromCache(cache, relPath) {
  delete cache.fileData[relPath];
  delete cache.importGraph[relPath];
  delete cache.routesByFile[relPath];

  // Remove this file as a dependency target in other files' import lists
  for (const [file, deps] of Object.entries(cache.importGraph)) {
    cache.importGraph[file] = deps.filter(d => d !== relPath);
  }
}

/**
 * insertFileData(cache, relPath, extracted, content, projectRoot)
 * Inserts freshly extracted data for one file into the cache.
 */
function insertFileData(cache, relPath, extracted, content, projectRoot) {
  cache.fileData[relPath] = {
    routes: extracted.routes || [],
    models: extracted.models || [],
    functions: extracted.functions || [],
    envVars: extracted.envVars || [],
    dbTables: extracted.dbTables || [],
    fetches: extracted.fetches || [],
    storageKeys: extracted.storageKeys || [],
  };

  if (extracted.routes && extracted.routes.length > 0) {
    cache.routesByFile[relPath] = extracted.routes.map(r => `${r.method} ${r.path}`);
  } else {
    delete cache.routesByFile[relPath];
  }

  // Re-extract imports for this file and update graph edges
  const absPath = path.join(projectRoot, relPath);
  const imports = extractImports(content, absPath, projectRoot);
  cache.importGraph[relPath] = imports;
}

/**
 * recomputeGraphMetrics(cache)
 * Recalculates highImpact, entryPoints, and domain clusters from current cache state.
 * Called after every incremental update.
 */
function recomputeGraphMetrics(cache) {
  const importGraph = cache.importGraph;

  // Fan-in count per file (how many files import it)
  const depCount = {};
  const allValues = new Set();
  for (const deps of Object.values(importGraph)) {
    for (const dep of deps) {
      depCount[dep] = (depCount[dep] || 0) + 1;
      allValues.add(dep);
    }
  }

  // Entry points: files that nothing imports, but import 3+ others
  cache.entryPoints = Object.keys(importGraph)
    .filter(f => !allValues.has(f) && importGraph[f].length >= 3)
    .sort();

  // High impact: files imported by 2+ others
  cache.highImpact = Object.entries(depCount)
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .map(([file, dependents]) => ({ file, dependents }));

  // Rebuild domain clusters from all file data
  const allRoutes = [];
  const allModels = [];
  const allFunctions = {};
  const allEnvVars = [];
  const allDbTables = [];
  const fileMap = [];

  for (const [relPath, data] of Object.entries(cache.fileData)) {
    allRoutes.push(...data.routes);
    allModels.push(...data.models);
    if (data.functions && data.functions.length > 0) {
      allFunctions[relPath] = data.functions;
    }
    for (const v of data.envVars) {
      if (!allEnvVars.find(e => e.name === v)) {
        allEnvVars.push({ name: v, files: [] });
      }
      const entry = allEnvVars.find(e => e.name === v);
      if (!entry.files.includes(relPath)) entry.files.push(relPath);
    }
    allDbTables.push(...(data.dbTables || []).map(t => ({ ...t, file: relPath })));
  }

  cache.domains = clusterByDomain({
    routes: allRoutes,
    models: allModels,
    functions: allFunctions,
    envVars: allEnvVars,
    dbTables: allDbTables,
    fileMap,
    routesByFile: cache.routesByFile,
    importGraph
  });

  // Update meta
  cache.meta = {
    totalFiles: Object.keys(cache.fileData).length,
    totalRoutes: allRoutes.length,
    totalImportEdges: Object.values(importGraph).reduce((s, d) => s + d.length, 0),
    lastIndexed: new Date().toISOString(),
    indexDuration: cache.meta.indexDuration || 0
  };
}

/**
 * applyIncrementalUpdate(cache, relPath, extracted, content, projectRoot)
 *
 * Main entry point for incremental updates.
 * Call when a single file changes — updates only that file's data,
 * then recomputes graph metrics.
 *
 * Returns the updated cache (mutated in place).
 */
function applyIncrementalUpdate(cache, relPath, extracted, content, projectRoot) {
  removeFileFromCache(cache, relPath);
  insertFileData(cache, relPath, extracted, content, projectRoot);
  recomputeGraphMetrics(cache);
  return cache;
}

/**
 * removeFileFromGraph(cache, relPath)
 * Call when a file is deleted.
 */
function removeFileFromGraph(cache, relPath) {
  removeFileFromCache(cache, relPath);
  recomputeGraphMetrics(cache);
  return cache;
}

module.exports = { applyIncrementalUpdate, removeFileFromGraph, recomputeGraphMetrics };
