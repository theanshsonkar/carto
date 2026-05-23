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

  // Collect all files that depend on matchedFile (up to 3 hops)
  const dependentFiles = collectDependents(matchedFile, imports, 3);
  // Also include the file itself — routes in the target file are affected
  dependentFiles.add(matchedFile);

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
  // Use routesByFile for precise file→route mapping
  const affectedRoutes = new Set();
  for (const affectedFile of dependentFiles) {
    const fileRoutes = map.routesByFile && map.routesByFile[affectedFile];
    if (fileRoutes) {
      for (const r of fileRoutes) affectedRoutes.add(r);
    }
  }
  // Also check the target file itself
  if (map.routesByFile && map.routesByFile[matchedFile]) {
    for (const r of map.routesByFile[matchedFile]) affectedRoutes.add(r);
  }

  // Fall back to all routes only if no file-specific routes found and an entry point is hit
  if (affectedRoutes.size === 0) {
    const entryPointsInChain = map.entryPoints
      ? map.entryPoints.filter(ep => dependentFiles.has(ep))
      : [];
    if (entryPointsInChain.length > 0) {
      for (const route of routes) {
        affectedRoutes.add(`${route.method} ${route.path}`);
      }
    }
  }

  if (affectedRoutes.size > 0) {
    for (const r of [...affectedRoutes].sort()) {
      console.log(`  → ${r}`);
    }
  } else {
    console.log('  (none — no route-serving files in the dependency chain)');
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
  const allFiles = new Set();
  for (const [file, deps] of Object.entries(imports)) {
    allFiles.add(file);
    for (const dep of deps) allFiles.add(dep);
  }

  const normalized = fileArg.replace(/\\/g, '/');
  const hasPathSeparator = normalized.includes('/');

  // Exact match
  if (allFiles.has(normalized)) return normalized;

  // Match by suffix (partial path)
  const matches = [...allFiles].filter(f => f.endsWith('/' + normalized) || f === normalized);
  if (matches.length === 1) return matches[0];

  // If input was a path (contains /), don't fall back to basename — it's ambiguous
  if (hasPathSeparator) {
    if (matches.length > 1) return null;
    return null;
  }

  // Input is just a filename — fall back to basename matching
  const byBasename = [...allFiles].filter(f => path.basename(f) === path.basename(normalized));
  if (byBasename.length === 1) return byBasename[0];

  // Multiple basename matches — ambiguous, don't guess
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
