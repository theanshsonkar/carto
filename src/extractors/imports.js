const path = require('path');
const fs = require('fs');

/**
 * extractImports(content, filePath, projectRoot) → Array<string>
 *
 * Extracts relative import paths from a source file.
 * Returns resolved relative paths (from project root) of local dependencies.
 *
 * JS/TS patterns:
 *   import X from './Y'
 *   import { X } from './Y'
 *   import './Y'
 *   const X = require('./Y')
 *   require('./Y')
 *
 * Python patterns:
 *   from .module import X        (relative)
 *   from ..module import X       (relative)
 *   from app.module import X     (local package — resolved if file exists)
 *   import .module               (relative)
 *
 * R patterns:
 *   library(pkg) / require(pkg)  (package name recorded as-is)
 *   source("./file.R")           (resolved if file exists)
 *
 * Only includes paths that resolve to actual files in the project.
 * Skips: node_modules, non-code files, anything that doesn't resolve.
 */
function extractImports(content, filePath, projectRoot) {
  const ext = path.extname(filePath).toLowerCase();
  const fileDir = path.dirname(filePath);

  let rawImports = [];

  if (['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'].includes(ext)) {
    rawImports = extractJSImports(content);
  } else if (ext === '.py') {
    rawImports = extractPythonImports(content, filePath, projectRoot);
  } else if (ext === '.r') {
    return extractRImports(content, filePath, projectRoot);
  }

  // Resolve and deduplicate
  const resolved = new Set();

  for (const imp of rawImports) {
    const resolvedPath = resolveImportPath(imp, fileDir, projectRoot, ext);
    if (resolvedPath) {
      // Store as relative to project root
      const rel = path.relative(projectRoot, resolvedPath);
      resolved.add(rel);
    }
  }

  return [...resolved].sort();
}

/**
 * Extract import paths from JS/TS content. Relative paths only.
 */
function extractJSImports(content) {
  const imports = [];

  // import ... from './path'  or  import './path'
  const importPattern = /import\s+(?:[\s\S]*?\s+from\s+)?['"](\.[^'"]+)['"]/g;
  let match;
  while ((match = importPattern.exec(content)) !== null) {
    imports.push(match[1]);
  }

  // require('./path')
  const requirePattern = /require\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g;
  while ((match = requirePattern.exec(content)) !== null) {
    imports.push(match[1]);
  }

  return imports;
}

/**
 * Extract imports from R content.
 * library(pkg) / require(pkg) → package name recorded directly.
 * source("./file.R") → resolved relative path if the file exists.
 */
function extractRImports(content, filePath, projectRoot) {
  const results = new Set();
  const fileDir = path.dirname(filePath);

  const pkgRe = /(?:library|require)\s*\(\s*["']?(\w[\w.]+)["']?\s*\)/g;
  let m;
  while ((m = pkgRe.exec(content)) !== null) {
    results.add(m[1]);
  }

  const sourceRe = /source\s*\(\s*["']([^"']+)["']\s*\)/g;
  while ((m = sourceRe.exec(content)) !== null) {
    const abs = path.resolve(fileDir, m[1]);
    if (fs.existsSync(abs)) {
      results.add(path.relative(projectRoot, abs));
    }
  }

  return [...results].sort();
}

/**
 * Extract import paths from Python content. Relative imports only.
 */
function extractPythonImports(content, filePath, projectRoot) {
  const imports = [];
  const fileDir = path.dirname(filePath);

  // from .module import X  or  from ..module import X
  const fromRelPattern = /^from\s+(\.+\w*(?:\.\w+)*)\s+import/gm;
  let match;
  while ((match = fromRelPattern.exec(content)) !== null) {
    const resolved = resolvePythonRelativeImport(match[1], fileDir);
    if (resolved) imports.push(resolved);
  }

  // from app.module import X — try to resolve as local file
  const fromAbsPattern = /^from\s+(\w+(?:\.\w+)+)\s+import/gm;
  while ((match = fromAbsPattern.exec(content)) !== null) {
    const modulePath = match[1].replace(/\./g, path.sep);
    // Try from project root
    const resolved = tryResolvePythonModule(modulePath, projectRoot);
    if (resolved) {
      imports.push(resolved);
      continue;
    }
    // Try from file's directory (for cases like `from app.models` when inside aws-risk-agent/)
    const fromFileDir = tryResolvePythonModule(modulePath, fileDir);
    if (fromFileDir) {
      imports.push(fromFileDir);
      continue;
    }
    // Try from parent directories up to project root
    let searchDir = path.dirname(fileDir);
    while (searchDir.startsWith(projectRoot) && searchDir !== projectRoot) {
      const fromParent = tryResolvePythonModule(modulePath, searchDir);
      if (fromParent) {
        imports.push(fromParent);
        break;
      }
      searchDir = path.dirname(searchDir);
    }
  }

  return imports;
}

/**
 * Try to resolve a dotted Python module path from a base directory.
 */
function tryResolvePythonModule(modulePath, baseDir) {
  const asFile = path.join(baseDir, modulePath + '.py');
  if (fs.existsSync(asFile)) return asFile;
  const asInit = path.join(baseDir, modulePath, '__init__.py');
  if (fs.existsSync(asInit)) return asInit;
  return null;
}

/**
 * Resolve a Python relative import like '.models' or '..utils' to an absolute path.
 */
function resolvePythonRelativeImport(importStr, fileDir) {
  // Count leading dots
  let dots = 0;
  while (dots < importStr.length && importStr[dots] === '.') dots++;

  const modulePart = importStr.substring(dots);

  // Go up (dots - 1) directories from fileDir
  let baseDir = fileDir;
  for (let i = 1; i < dots; i++) {
    baseDir = path.dirname(baseDir);
  }

  if (!modulePart) return null;

  const modulePath = modulePart.replace(/\./g, path.sep);
  const asFile = path.join(baseDir, modulePath + '.py');
  if (fs.existsSync(asFile)) return asFile;

  const asInit = path.join(baseDir, modulePath, '__init__.py');
  if (fs.existsSync(asInit)) return asInit;

  return null;
}

/**
 * Resolve a JS/TS import path to an actual file.
 * Tries: exact, .js, .ts, .jsx, .tsx, /index.js, /index.ts
 */
function resolveImportPath(importPath, fileDir, projectRoot, sourceExt) {
  // For Python, importPath is already absolute
  if (path.isAbsolute(importPath)) {
    return fs.existsSync(importPath) ? importPath : null;
  }

  const base = path.resolve(fileDir, importPath);

  // Try exact
  if (fs.existsSync(base) && fs.statSync(base).isFile()) return base;

  // Try extensions
  const extensions = ['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs'];
  for (const ext of extensions) {
    const withExt = base + ext;
    if (fs.existsSync(withExt)) return withExt;
  }

  // Try index files
  for (const ext of extensions) {
    const indexFile = path.join(base, 'index' + ext);
    if (fs.existsSync(indexFile)) return indexFile;
  }

  return null;
}

/**
 * buildImportGraph(fileContents, projectRoot) → { 'relative/path.js': ['relative/dep.js', ...] }
 *
 * fileContents: Array of { filePath, content } (absolute paths)
 * Returns a map of relative file paths to their relative dependencies.
 * Only includes files that have at least one resolved dependency.
 */
function buildImportGraph(fileContents, projectRoot) {
  const graph = {};

  for (const { filePath, content } of fileContents) {
    const relPath = path.relative(projectRoot, filePath);
    const base = path.basename(filePath);

    // Skip generated files — they produce massive noisy edges
    if (base.includes('.generated.') || relPath.includes('__generated__')) continue;

    const deps = extractImports(content, filePath, projectRoot);
    if (deps.length > 0) {
      graph[relPath] = deps;
    }
  }

  return graph;
}

module.exports = { extractImports, buildImportGraph };
