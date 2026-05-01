const fs = require('fs');
const path = require('path');

const MAX_FILES_PER_CATEGORY = 50;

const PYTHON_IGNORE = new Set(['__pycache__', '.venv', 'venv', 'migrations', 'node_modules', '.git', '.carto']);
const JS_IGNORE = new Set(['node_modules', '.git', 'dist', 'build', '.carto', '.next', '.turbo', 'coverage', 'out', '.cache', 'generated', '__generated__', 'storybook-static', 'public', 'static']);
const HTML_IGNORE = new Set(['node_modules', '.git', '.carto']);

/**
 * discoverFiles(projectRoot, framework, isIgnored, secondaryFramework) → { routeFiles, modelFiles, frontendFiles }
 *
 * isIgnored is an optional function (filePath) → boolean from the .cartoignore parser.
 * If secondaryFramework is provided, discovers files for both and merges.
 */
function discoverFiles(projectRoot, framework, isIgnored, secondaryFramework) {
  const ignoreFn = isIgnored || (() => false);

  const primary = discoverForFramework(projectRoot, framework, ignoreFn);

  if (secondaryFramework) {
    const secondary = discoverForFramework(projectRoot, secondaryFramework, ignoreFn);
    // Merge and deduplicate
    const routeFiles = [...new Set([...primary.routeFiles, ...secondary.routeFiles])];
    const modelFiles = [...new Set([...primary.modelFiles, ...secondary.modelFiles])];
    const frontendFiles = [...new Set([...primary.frontendFiles, ...secondary.frontendFiles])];
    return {
      routeFiles: cap(routeFiles),
      modelFiles: cap(modelFiles),
      frontendFiles: cap(frontendFiles)
    };
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

    return {
      routeFiles: cap(pyFiles),
      modelFiles: cap(pyFiles),
      frontendFiles: cap(htmlFiles)
    };
  }

  if (['express', 'nextjs', 'react', 'node-generic'].includes(framework)) {
    const jsFiles = findFilesRecursive(projectRoot, ['.js', '.ts', '.jsx', '.tsx'], JS_IGNORE, ignoreFn)
      .filter(f => {
        const base = path.basename(f);
        return !base.includes('.test.') && !base.includes('.spec.');
      });
    const htmlFiles = findFilesRecursive(projectRoot, ['.html'], HTML_IGNORE, ignoreFn);

    return {
      routeFiles: cap(jsFiles),
      modelFiles: cap(jsFiles),
      frontendFiles: cap(htmlFiles)
    };
  }

  // Unknown framework — best effort
  const allCode = findFilesRecursive(projectRoot, ['.py', '.js', '.ts'], new Set(['node_modules', '.git', '__pycache__', '.venv', 'venv', '.carto']), ignoreFn);
  const htmlFiles = findFilesRecursive(projectRoot, ['.html'], HTML_IGNORE, ignoreFn);

  return {
    routeFiles: cap(allCode),
    modelFiles: cap(allCode),
    frontendFiles: cap(htmlFiles)
  };
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

function scoreFile(filePath) {
  const p = filePath.toLowerCase().replace(/\\/g, '/');
  const base = path.basename(p);
  if (base === 'main.py' || base === 'app.py' || base === 'server.ts' ||
      base === 'server.js' || base === 'app.ts' || base === 'index.ts' ||
      base === 'route.ts' || base === 'routes.ts' || base === 'routes.js') return 10;
  if (p.includes('/api/') || p.includes('/routes/') || p.includes('/route/')) return 9;
  if (p.includes('/models/') || p.includes('/schemas/') || p.includes('/schema/')) return 8;
  if (p.includes('/services/') || p.includes('/controllers/') || p.includes('/handlers/')) return 6;
  if (p.includes('/lib/') || p.includes('/utils/') || p.includes('/helpers/')) return 2;
  return 4;
}

function cap(files) {
  const scored = files.map(f => ({ f, score: scoreFile(f) }))
                      .sort((a, b) => b.score - a.score);
  if (scored.length > MAX_FILES_PER_CATEGORY) {
    console.warn(`[CARTO] Warning: Found ${scored.length} files, capping at ${MAX_FILES_PER_CATEGORY}`);
    return scored.slice(0, MAX_FILES_PER_CATEGORY).map(x => x.f);
  }
  return scored.map(x => x.f);
}

module.exports = { discoverFiles };
