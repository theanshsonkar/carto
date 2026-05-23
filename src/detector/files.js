const fs = require('fs');
const path = require('path');

const MAX_ROUTE_FILES = 150;    // all route files up to this — routes are never crowded out
const MAX_MODEL_FILES = 50;     // all model/schema files up to this
const MAX_UTILITY_FILES = 100;  // top N utilities by import count

const PYTHON_IGNORE = new Set(['__pycache__', '.venv', 'venv', 'migrations', 'node_modules', '.git', '.carto']);
const JS_IGNORE = new Set(['node_modules', '.git', 'dist', 'build', '.carto', '.next', '.turbo', 'coverage', 'out', '.cache', 'generated', '__generated__', 'storybook-static', 'public', 'static', 'playwright', 'e2e', '__tests__', 'fixtures', 'mocks', '__mocks__', 'cypress']);
const HTML_IGNORE = new Set(['node_modules', '.git', '.carto']);
const R_IGNORE = new Set(['.Rhistory', '.RData', 'packrat', 'renv', 'node_modules', '.git', '__pycache__', '.carto']);

/**
 * discoverFiles(projectRoot, framework, isIgnored, secondaryFramework) → { routeFiles, modelFiles, frontendFiles }
 */
function discoverFiles(projectRoot, framework, isIgnored, secondaryFramework) {
  const ignoreFn = isIgnored || (() => false);

  const primary = discoverForFramework(projectRoot, framework, ignoreFn);

  if (secondaryFramework) {
    const secondary = discoverForFramework(projectRoot, secondaryFramework, ignoreFn);
    const routeFiles = [...new Set([...primary.routeFiles, ...secondary.routeFiles])];
    const modelFiles = [...new Set([...primary.modelFiles, ...secondary.modelFiles])];
    const frontendFiles = [...new Set([...primary.frontendFiles, ...secondary.frontendFiles])];
    return { routeFiles, modelFiles, frontendFiles };
  }

  return primary;
}

function discoverForFramework(projectRoot, framework, ignoreFn) {
  if (['fastapi', 'django', 'flask', 'python-generic'].includes(framework)) {
    const pyFiles = findFilesRecursive(projectRoot, ['.py'], PYTHON_IGNORE, ignoreFn)
      .filter(f => {
        const base = path.basename(f);
        return !base.startsWith('test_') && !base.endsWith('_test.py');
      });
    const htmlFiles = findFilesRecursive(projectRoot, ['.html'], HTML_IGNORE, ignoreFn);

    if (pyFiles.length <= MAX_ROUTE_FILES + MAX_MODEL_FILES + MAX_UTILITY_FILES) {
      return { routeFiles: pyFiles, modelFiles: pyFiles, frontendFiles: htmlFiles };
    }

    return smartSelect(pyFiles, htmlFiles, projectRoot);
  }

  if (['express', 'nextjs', 'react', 'node-generic'].includes(framework)) {
    const jsFiles = findFilesRecursive(projectRoot, ['.js', '.ts', '.jsx', '.tsx', '.prisma'], JS_IGNORE, ignoreFn)
      .filter(f => {
        const base = path.basename(f);
        const rel = f.toLowerCase().replace(/\\/g, '/');
        return !base.includes('.test.') &&
               !base.includes('.spec.') &&
               !base.includes('.stories.') &&
               !rel.includes('/test/') &&
               !rel.includes('/tests/') &&
               !rel.includes('/e2e/') &&
               !rel.includes('/playwright/') &&
               !rel.includes('/__tests__/') &&
               !rel.includes('/fixtures/');
      });
    const htmlFiles = findFilesRecursive(projectRoot, ['.html'], HTML_IGNORE, ignoreFn);

    if (jsFiles.length <= MAX_ROUTE_FILES + MAX_MODEL_FILES + MAX_UTILITY_FILES) {
      return { routeFiles: jsFiles, modelFiles: jsFiles, frontendFiles: htmlFiles };
    }

    return smartSelect(jsFiles, htmlFiles, projectRoot);
  }

  if (['plumber', 'shiny', 'r-generic'].includes(framework)) {
    const rFiles = findFilesRecursive(projectRoot, ['.r'], R_IGNORE, ignoreFn)
      .filter(f => {
        const lbase = path.basename(f).toLowerCase();
        return !lbase.startsWith('test_') && !lbase.startsWith('test-') && !lbase.endsWith('_test.r');
      });

    if (rFiles.length <= MAX_ROUTE_FILES + MAX_MODEL_FILES + MAX_UTILITY_FILES) {
      return { routeFiles: rFiles, modelFiles: rFiles, frontendFiles: [] };
    }

    return smartSelect(rFiles, [], projectRoot);
  }

  // Unknown framework
  const allCode = findFilesRecursive(projectRoot, ['.py', '.js', '.ts'], new Set(['node_modules', '.git', '__pycache__', '.venv', 'venv', '.carto']), ignoreFn);
  const htmlFiles = findFilesRecursive(projectRoot, ['.html'], HTML_IGNORE, ignoreFn);

  if (allCode.length <= MAX_ROUTE_FILES + MAX_MODEL_FILES + MAX_UTILITY_FILES) {
    return { routeFiles: allCode, modelFiles: allCode, frontendFiles: htmlFiles };
  }

  return smartSelect(allCode, htmlFiles, projectRoot);
}

function smartSelect(allFiles, htmlFiles, projectRoot) {
  console.warn(`[CARTO] Warning: Found ${allFiles.length} files, selecting by tier`);

  const routeCandidates = [];
  const modelCandidates = [];
  const otherFiles = [];

  for (const f of allFiles) {
    if (isRouteFile(f)) {
      routeCandidates.push(f);
    } else if (isModelFile(f)) {
      modelCandidates.push(f);
    } else {
      otherFiles.push(f);
    }
  }

  // Tier 1 — routes: all of them up to MAX_ROUTE_FILES
  // Split tRPC routers and REST routes, tRPC gets up to 50 slots
  const trpcRouters = routeCandidates.filter(f => f.includes('/routers/'));
  const restRoutes = routeCandidates.filter(f => !f.includes('/routers/'));

  trpcRouters.sort((a, b) => scoreRoute(b) - scoreRoute(a));
  restRoutes.sort((a, b) => scoreRoute(b) - scoreRoute(a));

  const trpcSelected = trpcRouters.slice(0, Math.min(trpcRouters.length, 50));
  const restSelected = restRoutes.slice(0, Math.min(restRoutes.length, MAX_ROUTE_FILES - trpcSelected.length));
  const selectedRoutes = [...trpcSelected, ...restSelected];

  // Tier 2 — models: all of them up to MAX_MODEL_FILES
  modelCandidates.sort((a, b) => scoreModel(b) - scoreModel(a));
  const selectedModels = modelCandidates.slice(0, MAX_MODEL_FILES);

  // Tier 3 — utilities: top N by import count
  const importCounts = countImportReferences(allFiles, projectRoot);
  otherFiles.sort((a, b) => {
    const relA = path.relative(projectRoot, a);
    const relB = path.relative(projectRoot, b);
    return (importCounts[relB] || 0) - (importCounts[relA] || 0);
  });

  const alreadySelected = new Set([...selectedRoutes, ...selectedModels]);
  const selectedUtilities = otherFiles
    .filter(f => !alreadySelected.has(f))
    .slice(0, MAX_UTILITY_FILES);

  const allSelected = [...new Set([...selectedRoutes, ...selectedModels, ...selectedUtilities])];

  console.warn(`[CARTO] Selected: ${selectedRoutes.length} route files, ${selectedModels.length} model files, ${selectedUtilities.length} utility files`);

  return {
    routeFiles: allSelected,
    modelFiles: allSelected,
    frontendFiles: htmlFiles.slice(0, 10)
  };
}

function isRouteFile(filePath) {
  const p = filePath.toLowerCase().replace(/\\/g, '/');
  const base = path.basename(p);
  if (base === 'route.ts' || base === 'route.js' || base === 'routes.ts' || base === 'routes.js') return true;
  if (p.includes('/api/') || p.includes('/routes/') || p.includes('/route/')) return true;
  if (p.includes('/routers/')) return true;
  if (base === 'main.py' || base === 'app.py' || base === 'server.ts' || base === 'server.js') return true;
  if (p.includes('/pages/api/')) return true;
  return false;
}

function isModelFile(filePath) {
  const p = filePath.toLowerCase().replace(/\\/g, '/');
  const base = path.basename(p);
  if (base === 'schema.prisma' || base.endsWith('.prisma')) return true;
  if (base.startsWith('models.') || base.includes('.model.') || base.includes('.models.')) return true;
  if (p.includes('/models/') || p.includes('/schemas/') || p.includes('/schema/')) return true;
  if (base.includes('entity') || base.includes('schema')) return true;
  return false;
}

function scoreRoute(filePath) {
  const p = filePath.toLowerCase().replace(/\\/g, '/');
  const base = path.basename(p);
  if (base === 'main.py' || base === 'app.py' || base === 'server.ts' || base === 'server.js') return 10;
  if (p.includes('/app/api/')) return 9;
  if (p.includes('/pages/api/')) return 8;
  if (p.includes('/routers/')) return 9;
  if (p.includes('/routes/') || p.includes('/api/')) return 7;
  return 5;
}

function scoreModel(filePath) {
  const p = filePath.toLowerCase().replace(/\\/g, '/');
  const base = path.basename(p);
  if (base === 'schema.prisma') return 10;
  if (base.startsWith('models.')) return 9;
  if (p.includes('/models/')) return 8;
  if (base.includes('.model.')) return 7;
  return 5;
}

/**
 * Quick scan of all files for import/require statements.
 * Returns { 'relative/path': count } of how many files import each path.
 */
function countImportReferences(allFiles, projectRoot) {
  const counts = {};

  // Build a set of known relative paths for matching
  const knownPaths = new Set();
  for (const f of allFiles) {
    knownPaths.add(path.relative(projectRoot, f));
  }

  // Quick regex scan — don't parse AST, just count references
  const importPattern = /(?:from|import)\s+['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

  for (const filePath of allFiles) {
    let content;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }

    const fileDir = path.dirname(filePath);
    let match;
    importPattern.lastIndex = 0;
    while ((match = importPattern.exec(content)) !== null) {
      const importPath = match[1] || match[2];
      if (!importPath || !importPath.startsWith('.')) continue;

      // Try to resolve to a known file
      const resolved = tryResolve(importPath, fileDir, projectRoot, knownPaths);
      if (resolved) {
        counts[resolved] = (counts[resolved] || 0) + 1;
      }
    }
  }

  return counts;
}

/**
 * Try to resolve a relative import to a known file path.
 */
function tryResolve(importPath, fileDir, projectRoot, knownPaths) {
  const base = path.resolve(fileDir, importPath);
  const rel = path.relative(projectRoot, base);

  // Try exact
  if (knownPaths.has(rel)) return rel;

  // Try extensions
  const extensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.py'];
  for (const ext of extensions) {
    const withExt = rel + ext;
    if (knownPaths.has(withExt)) return withExt;
  }

  // Try index files
  for (const ext of extensions) {
    const indexFile = path.join(rel, 'index' + ext);
    if (knownPaths.has(indexFile)) return indexFile;
  }

  return null;
}

function findFilesRecursive(dir, extensions, ignoreDirs, isIgnored, results = []) {
  let items;
  try {
    items = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const item of items) {
    if (ignoreDirs.has(item.name)) continue;

    const fullPath = path.join(dir, item.name);

    if (item.isDirectory()) {
      findFilesRecursive(fullPath, extensions, ignoreDirs, isIgnored, results);
    } else if (item.isFile()) {
      const ext = path.extname(item.name).toLowerCase();
      if (extensions.includes(ext) && !isIgnored(fullPath)) {
        results.push(fullPath);
      }
    }
  }
  return results;
}

module.exports = { discoverFiles };
