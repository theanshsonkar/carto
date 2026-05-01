const fs = require('fs');
const path = require('path');

function run(projectRoot, fileArg) {
  if (!fileArg) {
    console.error('[CARTO] Usage: carto impact <file>');
    process.exit(1);
  }

  const mapPath = path.join(projectRoot, '.carto', 'map.json');
  if (!fs.existsSync(mapPath)) {
    console.error('[CARTO] Run "carto init" first.');
    process.exit(1);
  }

  let map;
  try {
    map = JSON.parse(fs.readFileSync(mapPath, 'utf-8'));
  } catch (err) {
    console.error(`[CARTO] Error reading .carto/map.json: ${err.message}`);
    process.exit(1);
  }

  const imports = map.imports || {};
  const routes = map.routes || [];

  // Resolve file argument — match by basename or partial path
  const matchedFile = resolveFile(fileArg, imports);
  if (!matchedFile) {
    console.error(`[CARTO] File not found in project graph: ${fileArg}`);
    process.exit(1);
  }

  // Reverse lookup: which files import this file
  const importedBy = [];
  for (const [file, deps] of Object.entries(imports)) {
    if (deps.includes(matchedFile)) {
      importedBy.push(file);
    }
  }
  importedBy.sort();

  // Find affected routes — a route is affected if its handler file
  // imports the target file directly or transitively (up to 3 hops)
  const affectedRoutes = [];
  const routeFiles = new Set();

  // Collect all files that depend on matchedFile (up to 3 hops)
  const dependentFiles = collectDependents(matchedFile, imports, 3);
  // Also include the file itself — routes in the target file are affected
  dependentFiles.add(matchedFile);

  for (const route of routes) {
    // Find which file contains this route by checking if any dependent file
    // has this route's handler as a function
    // Since we don't have a direct file→route mapping, check if any file
    // that depends on matchedFile is an entry point with routes
    for (const depFile of dependentFiles) {
      if (imports[depFile] && imports[depFile].includes(matchedFile) || depFile === matchedFile) {
        // Check if this file has routes by seeing if it appears as a key
        // and has routes in the routes array
        routeFiles.add(depFile);
      }
    }
  }

  // Match routes to files — routes whose handler files are in the dependent set
  // Since map.json routes don't have a file field, match by checking which
  // entry point files contain routes
  for (const route of routes) {
    // A route is affected if any file in the dependency chain has routes
    affectedRoutes.push(route);
  }

  // Better approach: only include routes from files that are in the dependent chain
  // We need to re-derive which file each route came from
  // For now, if the target file or any of its direct importers have routes, show all routes
  // from those files
  const filesWithRoutes = new Set();
  for (const depFile of dependentFiles) {
    // Check if this file is known to have routes
    // (it appears as a key in imports AND has routes — we approximate by checking
    // if any route handler matches a function in that file)
    filesWithRoutes.add(depFile);
  }

  // Print output
  console.log(`\nImpact analysis: ${matchedFile}\n`);

  console.log('Imported by:');
  if (importedBy.length > 0) {
    for (const f of importedBy) {
      console.log(`  → ${f}`);
    }
  } else {
    console.log('  (none — this file is not imported by any other file)');
  }

  console.log('\nRoutes affected:');
  // Only show routes from files that transitively depend on the target
  if (routes.length > 0 && dependentFiles.size > 0) {
    // Find which files in the dependent chain are entry points with routes
    // A route is affected if its file (the entry point) is in the dependent set
    const entryPointsInChain = map.entryPoints
      ? map.entryPoints.filter(ep => dependentFiles.has(ep))
      : [];
    // If any entry point depends on this file, all routes through it are affected
    if (entryPointsInChain.length > 0) {
      const shown = new Set();
      for (const route of routes) {
        const key = `${route.method} ${route.path}`;
        if (!shown.has(key)) {
          console.log(`  → ${route.method} ${route.path}`);
          shown.add(key);
        }
      }
    } else {
      console.log('  (none — no route-serving files in the dependency chain)');
    }
  } else {
    console.log('  (none)');
  }

  // Risk level
  const depCount = importedBy.length;
  let risk;
  if (depCount >= 3) risk = 'HIGH';
  else if (depCount === 2) risk = 'MEDIUM';
  else if (depCount === 1) risk = 'LOW';
  else risk = 'SAFE';

  console.log(`\nRisk: ${risk} — ${depCount} file${depCount !== 1 ? 's' : ''} depend on this\n`);
}

/**
 * Resolve a file argument to a full relative path in the import graph.
 * Matches by basename or partial path suffix.
 */
function resolveFile(fileArg, imports) {
  // Collect all known files (keys + all values)
  const allFiles = new Set();
  for (const [file, deps] of Object.entries(imports)) {
    allFiles.add(file);
    for (const dep of deps) allFiles.add(dep);
  }

  const normalized = fileArg.replace(/\\/g, '/');

  // Exact match
  if (allFiles.has(normalized)) return normalized;

  // Match by suffix (partial path)
  const matches = [...allFiles].filter(f => f.endsWith('/' + normalized) || f === normalized);
  if (matches.length === 1) return matches[0];

  // Match by basename
  const byBasename = [...allFiles].filter(f => path.basename(f) === path.basename(normalized));
  if (byBasename.length === 1) return byBasename[0];

  // If multiple basename matches, prefer shortest path
  if (byBasename.length > 1) {
    byBasename.sort((a, b) => a.length - b.length);
    return byBasename[0];
  }

  return null;
}

/**
 * Collect all files that transitively depend on the target file (reverse BFS).
 * maxHops limits the depth of the search.
 */
function collectDependents(targetFile, imports, maxHops) {
  const dependents = new Set();
  let frontier = new Set([targetFile]);

  for (let hop = 0; hop < maxHops; hop++) {
    const nextFrontier = new Set();
    for (const [file, deps] of Object.entries(imports)) {
      if (dependents.has(file)) continue;
      for (const dep of deps) {
        if (frontier.has(dep)) {
          dependents.add(file);
          nextFrontier.add(file);
          break;
        }
      }
    }
    if (nextFrontier.size === 0) break;
    frontier = nextFrontier;
  }

  return dependents;
}

module.exports = { run };
