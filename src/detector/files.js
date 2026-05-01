const fs = require('fs');
const path = require('path');

const MAX_FILES_PER_CATEGORY = 50;

const PYTHON_IGNORE = new Set(['__pycache__', '.venv', 'venv', 'migrations', 'node_modules', '.git', '.carto']);
const JS_IGNORE = new Set(['node_modules', '.git', 'dist', 'build', '.carto']);
const HTML_IGNORE = new Set(['node_modules', '.git', '.carto']);

/**
 * discoverFiles(projectRoot, framework, isIgnored) → { routeFiles, modelFiles, frontendFiles }
 *
 * isIgnored is an optional function (filePath) → boolean from the .cartoignore parser.
 */
function discoverFiles(projectRoot, framework, isIgnored) {
  const ignoreFn = isIgnored || (() => false);

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

function cap(files) {
  if (files.length > MAX_FILES_PER_CATEGORY) {
    console.warn(`[CARTO] Warning: Found ${files.length} files, capping at ${MAX_FILES_PER_CATEGORY}`);
    return files.slice(0, MAX_FILES_PER_CATEGORY);
  }
  return files;
}

module.exports = { discoverFiles };
