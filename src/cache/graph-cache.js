'use strict';

const fs = require('fs');
const path = require('path');

function getCachePath(projectRoot) {
  return path.join(projectRoot, '.carto', 'graph-cache.json');
}

/**
 * loadGraphCache(projectRoot)
 * Returns the full persisted graph or null if not found / corrupt.
 *
 * Cache shape:
 * {
 *   version: '2',
 *   generated: ISO string,
 *   fileData: {
 *     [relPath]: { routes, models, functions, envVars, dbTables, fetches, storageKeys, imports }
 *   },
 *   importGraph: { [relPath]: [relPath, ...] },
 *   routesByFile: { [relPath]: ['METHOD /path', ...] },
 *   domains: { [domain]: { files, routes, models, functions, envVars, dbTables } },
 *   highImpact: [{ file, dependents }],
 *   entryPoints: [relPath, ...],
 *   stack: [...],
 *   meta: { totalFiles, totalRoutes, totalImportEdges, lastIndexed, indexDuration }
 * }
 */
function loadGraphCache(projectRoot) {
  try {
    const raw = fs.readFileSync(getCachePath(projectRoot), 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed.version !== '2') return null;
    return parsed;
  } catch {
    return null;
  }
}

function saveGraphCache(projectRoot, cache) {
  const cachePath = getCachePath(projectRoot);
  const tmp = cachePath + '.tmp';
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2) + '\n', 'utf-8');
    fs.renameSync(tmp, cachePath);
  } catch (err) {
    console.warn(`[CARTO] Warning: Could not save graph cache — ${err.message}`);
  }
}

/**
 * buildEmptyCache() — starting point for a fresh index
 */
function buildEmptyCache() {
  return {
    version: '2',
    generated: new Date().toISOString(),
    fileData: {},
    importGraph: {},
    routesByFile: {},
    domains: {},
    highImpact: [],
    entryPoints: [],
    stack: [],
    meta: {
      totalFiles: 0,
      totalRoutes: 0,
      totalImportEdges: 0,
      lastIndexed: null,
      indexDuration: 0
    }
  };
}

module.exports = { loadGraphCache, saveGraphCache, buildEmptyCache, getCachePath };
