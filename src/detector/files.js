const fs = require('fs');
const path = require('path');

const MAX_FILES_TOTAL = 80;
const BASE_ROUTE_BUDGET = 20;
const MODEL_BUDGET = 10;
const BASE_UTILITY_BUDGET = 20;

const PYTHON_IGNORE = new Set(['__pycache__', '.venv', 'venv', 'migrations', 'node_modules', '.git', '.carto']);
const JS_IGNORE = new Set(['node_modules', '.git', 'dist', 'build', '.carto', '.next', '.turbo', 'coverage', 'out', '.cache', 'generated', '__generated__', 'storybook-static', 'public', 'static']);
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

    if (pyFiles.length <= MAX_FILES_TOTAL) {
      return { routeFiles: pyFiles, modelFiles: pyFiles, frontendFiles: htmlFiles };
    }

    return smartSelect(pyFiles, htmlFiles, projectRoot);
  }

  if (['express', 'nextjs', 'react', 'node-generic'].includes(framework)) {
    const jsFiles = findFilesRecursive(projectRoot, ['.js', '.ts', '.jsx', '.tsx', '.prisma'], JS_IGNORE, ignoreFn)
      .filter(f => {
        const base = path.basename(f);
        return !base.includes('.test.') && !base.includes('.spec.');
      });
    const htmlFiles = findFilesRecursive(projectRoot, ['.html'], HTML_IGNORE, ignoreFn);

    if (jsFiles.length <= MAX_FILES_TOTAL) {
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

    if (rFiles.length <= MAX_FILES_TOTAL) {
      return { routeFiles: rFiles, modelFiles: rFiles, frontendFiles: [] };
    }

    return smartSelect(rFiles, [], projectRoot);
  }

  // Unknown framework
  const allCode = findFilesRecursive(projectRoot, ['.py', '.js', '.ts'], new Set(['node_modules', '.git', '__pycache__', '.venv', 'venv', '.carto']), ignoreFn);
  const htmlFiles = findFilesRecursive(projectRoot, ['.html'], HTML_IGNORE, ignoreFn);

  if (allCode.length <= MAX_FILES_TOTAL) {
    return { routeFiles: allCode, modelFiles: allCode, frontendFiles: htmlFiles };
  }

  return smartSelect(allCode, htmlFiles, projectRoot);
}

/**
 * Smart file selection within the 50-file budget.
 * Allocates: up to 20 route files, up to 10 model files, up to 20 utility files.
 */
function smartSelect(allFiles, htmlFiles, projectRoot) {
  console.warn(`[CARTO] Warning: Found ${allFiles.length} files, selecting top ${MAX_FILES_TOTAL} by importance`);

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

  // Dynamic route budget — expand if many route files, compensate from utility budget
  const routeBudget = routeCandidates.length > BASE_ROUTE_BUDGET
    ? Math.min(routeCandidates.length, 40)
    : BASE_ROUTE_BUDGET;
  const utilityBudget = Math.max(10, MAX_FILES_TOTAL - routeBudget - MODEL_BUDGET);

  routeCandidates.sort((a, b) => scoreRoute(b) - scoreRoute(a));
  const selectedRoutes = routeCandidates.slice(0, routeBudget);

  modelCandidates.sort((a, b) => scoreModel(b) - scoreModel(a));
  const selectedModels = modelCandidates.slice(0, MODEL_BUDGET);

  const importCounts = countImportReferences(allFiles, projectRoot);
  otherFiles.sort((a, b) => {
    const relA = path.relative(projectRoot, a);
    const relB = path.relative(projectRoot, b);
    return (importCounts[relB] || 0) - (importCounts[relA] || 0);
  });

  const alreadySelected = new Set([...selectedRoutes, ...selectedModels]);
  const remainingBudget = MAX_FILES_TOTAL - alreadySelected.size;
  const selectedUtilities = otherFiles
    .filter(f => !alreadySelected.has(f))
    .slice(0, Math.min(utilityBudget, remainingBudget));

  const allSelected = [...new Set([...selectedRoutes, ...selectedModels, ...selectedUtilities])];

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
