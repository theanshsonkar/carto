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
    // Python returns absolute paths from resolvePythonRelativeImport / tryResolvePythonModule.
    // Relativize to project root and return early — the JS-style dedup loop below only handles
    // `./` and `@/~/#` prefixed strings, so falling through silently drops every Python edge.
    const abs = extractPythonImports(content, filePath, projectRoot);
    return [...new Set(abs.map(p => path.relative(projectRoot, p)))].sort();
  } else if (ext === '.r') {
    return extractRImports(content, filePath, projectRoot);
  } else if (ext === '.go') {
    return extractGoImports(content, filePath, projectRoot);
  } else if (ext === '.rs') {
    return extractRustImports(content, filePath, projectRoot);
  } else if (['.java'].includes(ext)) {
    return extractJavaImports(content, filePath, projectRoot);
  } else if (ext === '.rb') {
    return extractRubyImports(content, filePath, projectRoot);
  } else if (['.cpp', '.cc', '.cxx', '.c', '.h', '.hpp', '.hh', '.hxx'].includes(ext)) {
    return extractCppImports(content, filePath, projectRoot);
  } else if (ext === '.cs') {
    return extractCsharpImports(content, filePath, projectRoot);
  }

  // Resolve and deduplicate
  const resolved = new Set();

  for (const imp of rawImports) {
    let resolvedPath;
    if (imp.startsWith('.')) {
      // Relative import
      resolvedPath = resolveImportPath(imp, fileDir, projectRoot, ext);
    } else {
      // Aliased import (@/, ~/, #/, etc.)
      const aliasedAbs = resolveAliasedImport(imp, projectRoot);
      if (aliasedAbs) {
        resolvedPath = resolveImportPath(aliasedAbs, path.dirname(aliasedAbs), projectRoot, ext);
        if (!resolvedPath) {
          // Try treating aliasedAbs as the base directly
          const extensions = ['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs'];
          if (fs.existsSync(aliasedAbs) && fs.statSync(aliasedAbs).isFile()) {
            resolvedPath = aliasedAbs;
          } else {
            for (const e of extensions) {
              if (fs.existsSync(aliasedAbs + e)) { resolvedPath = aliasedAbs + e; break; }
            }
            if (!resolvedPath) {
              for (const e of extensions) {
                const idx = path.join(aliasedAbs, 'index' + e);
                if (fs.existsSync(idx)) { resolvedPath = idx; break; }
              }
            }
          }
        }
      }
    }
    if (resolvedPath) {
      const rel = path.isAbsolute(resolvedPath)
        ? path.relative(projectRoot, resolvedPath)
        : resolvedPath;
      resolved.add(rel);
    }
  }

  return [...resolved].sort();
}

/**
 * Extract import paths from JS/TS content — both relative and aliased.
 */
function extractJSImports(content) {
  const imports = [];

  // import ... from 'path' — capture relative and aliased imports
  const importPattern = /import\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g;
  let match;
  while ((match = importPattern.exec(content)) !== null) {
    const p = match[1];
    if (p.startsWith('.') || p.startsWith('@') || p.startsWith('~') || p.startsWith('#')) {
      imports.push(p);
    }
  }

  // require('./path') or require('@/path')
  const requirePattern = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((match = requirePattern.exec(content)) !== null) {
    const p = match[1];
    if (p.startsWith('.') || p.startsWith('@') || p.startsWith('~') || p.startsWith('#')) {
      imports.push(p);
    }
  }

  return imports;
}

// Cache for path alias configs per projectRoot
const _aliasCache = new Map();

/**
 * loadPathAliases(projectRoot) → Map<prefix, absoluteDir>
 * Reads tsconfig.json / jsconfig.json / vite.config.* for path aliases.
 * e.g. "@/*" → "src/*" becomes "@/" → "/abs/path/to/src"
 */
function loadPathAliases(projectRoot) {
  if (_aliasCache.has(projectRoot)) return _aliasCache.get(projectRoot);

  const aliases = new Map();

  // Try tsconfig.json / jsconfig.json
  for (const configFile of ['tsconfig.json', 'jsconfig.json']) {
    const configPath = path.join(projectRoot, configFile);
    try {
      const raw = fs.readFileSync(configPath, 'utf-8');
      // Strip comments (tsconfig allows them)
      const cleaned = raw.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
      const config = JSON.parse(cleaned);
      const paths = config?.compilerOptions?.paths || {};
      const baseUrl = config?.compilerOptions?.baseUrl || '.';
      const base = path.resolve(projectRoot, baseUrl);

      for (const [alias, targets] of Object.entries(paths)) {
        if (!Array.isArray(targets) || targets.length === 0) continue;
        // "@/*" → strip trailing "/*" to get prefix "@/"
        const prefix = alias.replace(/\/\*$/, '/').replace(/\*$/, '');
        // targets[0] like "src/*" → strip "/*" → "src"
        const targetDir = targets[0].replace(/\/\*$/, '').replace(/\*$/, '');
        aliases.set(prefix, path.resolve(base, targetDir));
      }
      break; // use first found
    } catch {}
  }

  // Common conventions if no config found
  if (aliases.size === 0) {
    const srcDir = path.join(projectRoot, 'src');
    if (fs.existsSync(srcDir)) {
      aliases.set('@/', srcDir);
      aliases.set('~/', srcDir);
      aliases.set('#/', srcDir);
    }
  }

  _aliasCache.set(projectRoot, aliases);
  return aliases;
}

/**
 * resolveAliasedImport(importPath, projectRoot) → string | null
 * Resolves a path alias like "@/components/Button" to an absolute path.
 */
function resolveAliasedImport(importPath, projectRoot) {
  const aliases = loadPathAliases(projectRoot);
  for (const [prefix, targetDir] of aliases) {
    if (importPath.startsWith(prefix)) {
      const rest = importPath.slice(prefix.length);
      return path.join(targetDir, rest);
    }
  }
  return null;
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

// ─── Go imports ──────────────────────────────────────────────────────────────

// Cache go.mod module name per projectRoot — read once, reuse
const _goModCache = new Map();

function _getGoModuleName(projectRoot) {
  if (_goModCache.has(projectRoot)) return _goModCache.get(projectRoot);
  try {
    const content = fs.readFileSync(path.join(projectRoot, 'go.mod'), 'utf-8');
    const m = content.match(/^module\s+(\S+)/m);
    const name = m ? m[1] : null;
    _goModCache.set(projectRoot, name);
    return name;
  } catch {
    _goModCache.set(projectRoot, null);
    return null;
  }
}

/**
 * extractGoImports(content, filePath, projectRoot) → Array<string>
 *
 * Resolves local Go imports (same module) to actual .go files.
 * Requires go.mod at projectRoot to determine the module name.
 *
 * Handles:
 *   import "module/path/pkg"
 *   import ( "module/path/pkg1" \n "module/path/pkg2" )
 *   import alias "module/path/pkg"
 */
function extractGoImports(content, filePath, projectRoot) {
  const moduleName = _getGoModuleName(projectRoot);
  if (!moduleName) return [];

  const results = new Set();

  // Collect all import paths from both single and block imports
  const importPaths = [];

  // Single-line: import "path" or import alias "path"
  const singleRe = /^import\s+(?:\w+\s+)?"([^"]+)"/gm;
  let m;
  while ((m = singleRe.exec(content)) !== null) importPaths.push(m[1]);

  // Block: import ( ... )
  const blockRe = /import\s*\(([^)]+)\)/g;
  while ((m = blockRe.exec(content)) !== null) {
    const block = m[1];
    const lineRe = /"([^"]+)"/g;
    let lm;
    while ((lm = lineRe.exec(block)) !== null) importPaths.push(lm[1]);
  }

  // Resolve local imports only (starts with this module's name)
  const prefix = moduleName + '/';
  for (const imp of importPaths) {
    if (!imp.startsWith(prefix)) continue;
    const localPkg = imp.slice(prefix.length); // e.g. "internal/auth"
    const pkgDir = path.join(projectRoot, localPkg);

    // Find first non-test .go file in the package directory
    try {
      const entries = fs.readdirSync(pkgDir);
      const goFile = entries.find(e => e.endsWith('.go') && !e.endsWith('_test.go'));
      if (goFile) {
        results.add(path.relative(projectRoot, path.join(pkgDir, goFile)));
      }
    } catch { /* directory doesn't exist or can't be read */ }
  }

  return [...results].sort();
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

// ─── Rust imports ─────────────────────────────────────────────────────────────

/**
 * extractRustImports(content, filePath, projectRoot) → Array<string>
 *
 * Resolves Rust `use` declarations to actual .rs files in the project.
 * Handles:
 *   use crate::module::submodule  → src/module/submodule.rs or src/module/submodule/mod.rs
 *   use super::module             → ../module.rs
 *   use self::module              → ./module.rs
 *
 * External crates (std::, tokio::, etc.) are skipped — only local crate paths.
 */
function extractRustImports(content, filePath, projectRoot) {
  const results = new Set();
  const fileDir = path.dirname(filePath);

  // For Rust, `crate::` refers to the root of the current crate.
  // The crate root is typically the src/ directory containing this file.
  // We find it by walking up to the nearest src/ directory.
  const crateRoot = _findRustCrateRoot(filePath);

  let m;

  // Extract mod declarations (these declare submodules = file dependencies)
  // mod thread_switcher; → thread_switcher.rs or thread_switcher/mod.rs
  const modPattern = /^(?:pub\s+)?mod\s+(\w+)\s*;/gm;
  while ((m = modPattern.exec(content)) !== null) {
    const modName = m[1];
    const resolved = _resolveRustModule([modName], fileDir, projectRoot);
    if (resolved) results.add(resolved);
  }

  // Extract use declarations — handle both single and grouped
  // use crate::module;
  // use crate::{module1, module2};
  // use crate::module::sub;
  const usePattern = /^use\s+(crate|super|self)(::[\w:{}*,\s]+)?;/gm;
  while ((m = usePattern.exec(content)) !== null) {
    const prefix = m[1];
    const rest = (m[2] || '').replace(/^::/, '');
    if (!rest) continue;

    // Extract module paths from potentially grouped imports
    // e.g. "{module1, module2::sub}" → ["module1", "module2::sub"]
    const modulePaths = _expandRustUsePaths(rest);

    for (const modPath of modulePaths) {
      const parts = modPath.split('::').filter(p => p && p !== '*');
      if (parts.length === 0) continue;

      let baseDir;
      if (prefix === 'crate') {
        baseDir = crateRoot;
      } else if (prefix === 'super') {
        baseDir = path.dirname(fileDir);
      } else { // self
        baseDir = fileDir;
      }

      const resolved = _resolveRustModule(parts, baseDir, projectRoot);
      if (resolved) results.add(resolved);
    }
  }

  return [...results].sort();
}

function _findRustCrateRoot(filePath) {
  // Walk up from the file to find the nearest src/ directory
  let dir = path.dirname(filePath);
  while (dir !== path.dirname(dir)) {
    if (path.basename(dir) === 'src') return dir;
    dir = path.dirname(dir);
  }
  return path.dirname(filePath);
}

function _expandRustUsePaths(rest) {
  // Handle grouped imports: {module1, module2::sub} → ["module1", "module2::sub"]
  // Handle simple: module::sub → ["module::sub"]
  const trimmed = rest.trim();
  if (trimmed.startsWith('{')) {
    const inner = trimmed.slice(1, trimmed.lastIndexOf('}'));
    return inner.split(',').map(s => s.trim()).filter(Boolean);
  }
  return [trimmed];
}

function _resolveRustModule(moduleParts, baseDir, projectRoot) {
  if (moduleParts.length === 0) return null;

  const name = moduleParts[0];
  // Rust files are always lowercase; struct/type names in use paths are PascalCase
  // Try both the exact name and lowercase version
  const candidates = name === name.toLowerCase() ? [name] : [name.toLowerCase(), name];

  for (const candidate of candidates) {
    // Try: baseDir/module.rs
    const asFile = path.join(baseDir, candidate + '.rs');
    if (fs.existsSync(asFile)) {
      const rel = path.relative(projectRoot, asFile);
      if (moduleParts.length === 1) return rel;
      return _resolveRustModule(moduleParts.slice(1), path.join(baseDir, candidate), projectRoot) || rel;
    }

    // Try: baseDir/module/mod.rs
    const asMod = path.join(baseDir, candidate, 'mod.rs');
    if (fs.existsSync(asMod)) {
      const rel = path.relative(projectRoot, asMod);
      if (moduleParts.length === 1) return rel;
      return _resolveRustModule(moduleParts.slice(1), path.join(baseDir, candidate), projectRoot) || rel;
    }
  }

  return null;
}

// ─── Java imports ─────────────────────────────────────────────────────────────

/**
 * extractJavaImports(content, filePath, projectRoot) → Array<string>
 *
 * Resolves Java import statements to actual .java files in the project.
 * Only resolves imports that match files in the project (skips java.*, javax.*, etc.)
 */
function extractJavaImports(content, filePath, projectRoot) {
  const results = new Set();

  const importPattern = /^import\s+(?:static\s+)?([\w.]+);/gm;
  let m;
  while ((m = importPattern.exec(content)) !== null) {
    const importPath = m[1];
    const parts = importPath.split('.');

    // Skip standard library and common external packages
    if (['java', 'javax', 'org', 'com', 'net', 'io', 'android'].includes(parts[0])) {
      // Only resolve if it might be a local package
      // Try to find the file anyway
    }

    // Convert com.example.UserService → com/example/UserService.java
    const filePath2 = parts.join(path.sep) + '.java';

    // Search for this file in the project
    const candidates = [
      path.join(projectRoot, 'src', 'main', 'java', filePath2),
      path.join(projectRoot, 'src', filePath2),
      path.join(projectRoot, filePath2),
    ];

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        results.add(path.relative(projectRoot, candidate));
        break;
      }
    }
  }

  return [...results].sort();
}

// ─── Ruby imports ─────────────────────────────────────────────────────────────

/**
 * extractRubyImports(content, filePath, projectRoot) → Array<string>
 *
 * Resolves Ruby require/require_relative to actual .rb files.
 * require_relative 'path' → resolved relative to current file
 * require 'path' → resolved from project root (local files only)
 */
function extractRubyImports(content, filePath, projectRoot) {
  const results = new Set();
  const fileDir = path.dirname(filePath);

  // require_relative 'path' — always relative to current file
  const relPattern = /require_relative\s+['"]([^'"]+)['"]/g;
  let m;
  while ((m = relPattern.exec(content)) !== null) {
    const resolved = _resolveRubyPath(m[1], fileDir, projectRoot);
    if (resolved) results.add(resolved);
  }

  // require 'path' — try relative to project root lib/ and app/ dirs
  const absPattern = /\brequire\s+['"]([^'"]+)['"]/g;
  while ((m = absPattern.exec(content)) !== null) {
    const reqPath = m[1];
    // Skip gems (no slashes or known gem names)
    if (!reqPath.includes('/') && !reqPath.startsWith('.')) continue;

    const searchBases = [
      projectRoot,
      path.join(projectRoot, 'lib'),
      path.join(projectRoot, 'app'),
    ];
    for (const base of searchBases) {
      const resolved = _resolveRubyPath(reqPath, base, projectRoot);
      if (resolved) { results.add(resolved); break; }
    }
  }

  return [...results].sort();
}

function _resolveRubyPath(reqPath, baseDir, projectRoot) {
  const base = path.resolve(baseDir, reqPath);
  // Try exact
  if (fs.existsSync(base) && fs.statSync(base).isFile()) {
    return path.relative(projectRoot, base);
  }
  // Try with .rb extension
  const withExt = base + '.rb';
  if (fs.existsSync(withExt)) {
    return path.relative(projectRoot, withExt);
  }
  return null;
}


// ─── C / C++ imports ──────────────────────────────────────────────────────────

/**
 * extractCppImports(content, filePath, projectRoot) → Array<string>
 *
 * Resolves #include directives to actual files in the project.
 *
 *   #include "foo.h"      → resolved relative to current file's dir,
 *                           then common include search dirs.
 *   #include <foo>        → skipped (system header, external).
 *
 * Uses tree-sitter-cpp when available, otherwise falls back to a
 * simple regex over the source.
 */
function extractCppImports(content, filePath, projectRoot) {
  const results = new Set();
  const fileDir = path.dirname(filePath);
  const ext = path.extname(filePath);

  // Pull raw includes via tree-sitter when available; fall back to regex.
  let rawImports = [];
  try {
    const tsParser = require('./tree-sitter-parser');
    if (tsParser.isAvailable()) {
      rawImports = tsParser.extractImports(content, ext);
    }
  } catch { /* tree-sitter unavailable */ }

  if (rawImports.length === 0) {
    const re = /^\s*#\s*include\s+(?:"([^"]+)"|<([^>]+)>)/gm;
    let m;
    while ((m = re.exec(content)) !== null) {
      // m[1] is quoted form, m[2] is angle-bracket form. Keep both shapes
      // so the system-header filter below can drop the angle ones.
      if (m[1]) rawImports.push(m[1]);
      else if (m[2]) rawImports.push('<' + m[2] + '>');
    }
  }

  for (const raw of rawImports) {
    // Drop system headers (angle brackets). Tree-sitter returns these as
    // "<string>" wrappers; the regex form we just constructed does too.
    if (raw.startsWith('<') && raw.endsWith('>')) continue;
    // Defensive: a tree-sitter grammar quirk could leak the wrappers in.
    if (raw.startsWith('"') && raw.endsWith('"')) {
      const inner = raw.slice(1, -1);
      _tryResolveCppInclude(inner, fileDir, projectRoot, results);
      continue;
    }
    _tryResolveCppInclude(raw, fileDir, projectRoot, results);
  }

  return [...results].sort();
}

function _tryResolveCppInclude(includePath, fileDir, projectRoot, results) {
  // Search order: relative to current file, then common include roots.
  const candidates = [
    path.resolve(fileDir, includePath),
    path.join(projectRoot, 'include', includePath),
    path.join(projectRoot, 'src', 'include', includePath),
    path.join(projectRoot, 'src', includePath),
    path.join(projectRoot, includePath),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) {
      results.add(path.relative(projectRoot, c));
      return;
    }
  }
}

// ─── C# imports ───────────────────────────────────────────────────────────────

// Cache: projectRoot → Map<namespace, Array<relativeFilePath>>
const _csNamespaceCache = new Map();

/**
 * Build a namespace → files map by scanning every .cs file in the project
 * once. Cached per projectRoot. This is the only reliable way to resolve
 * `using A.B.C;` in C# because (unlike Java) namespace and folder structure
 * are decoupled — a namespace can span many files in many directories.
 */
function _getCsharpNamespaceMap(projectRoot) {
  if (_csNamespaceCache.has(projectRoot)) return _csNamespaceCache.get(projectRoot);
  const map = new Map();

  const SKIP_DIRS = new Set(['node_modules', 'bin', 'obj', 'packages', '.git', 'dist', 'build']);
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name));
        continue;
      }
      if (!e.isFile() || !e.name.endsWith('.cs')) continue;
      const full = path.join(dir, e.name);
      let c;
      try { c = fs.readFileSync(full, 'utf-8'); } catch { continue; }
      // Match both file-scoped (`namespace Foo;`) and block-scoped (`namespace Foo {`).
      const m = c.match(/^\s*namespace\s+([\w.]+)\s*[;{]/m);
      if (!m) continue;
      const ns = m[1];
      const rel = path.relative(projectRoot, full);
      if (!map.has(ns)) map.set(ns, []);
      map.get(ns).push(rel);
    }
  };

  walk(projectRoot);
  _csNamespaceCache.set(projectRoot, map);
  return map;
}

/**
 * extractCsharpImports(content, filePath, projectRoot) → Array<string>
 *
 * Resolves `using Foo.Bar.Baz;` to project files that declare the
 * matching namespace. Skips standard library namespaces (System.*,
 * Microsoft.*, etc.) — those produce only noise.
 */
function extractCsharpImports(content, filePath, projectRoot) {
  const results = new Set();
  const nsMap = _getCsharpNamespaceMap(projectRoot);

  // System namespaces and well-known third-party prefixes that almost never
  // resolve to project files. We still check the map (a project could ship a
  // Microsoft.* namespace), but skip the FS fallback for these.
  const EXTERNAL_PREFIXES = ['System', 'Microsoft', 'Windows', 'Newtonsoft', 'Xunit', 'NUnit', 'Mono'];

  const re = /^\s*using\s+(?:static\s+)?([\w.]+)\s*;/gm;
  let m;
  while ((m = re.exec(content)) !== null) {
    const ns = m[1];
    const isExternal = EXTERNAL_PREFIXES.includes(ns.split('.')[0]);

    // Primary path: namespace map lookup. Works regardless of folder layout.
    const matched = nsMap.get(ns);
    if (matched) {
      for (const f of matched) results.add(f);
      continue;
    }

    if (isExternal) continue;

    // Fallback: filename convention (Foo.Bar.Baz → Foo/Bar/Baz.cs).
    const parts = ns.split('.');
    const asFile = parts.join(path.sep) + '.cs';
    const candidates = [
      path.join(projectRoot, 'src', asFile),
      path.join(projectRoot, asFile),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        results.add(path.relative(projectRoot, c));
        break;
      }
    }
  }

  // Drop self-import — a file's `namespace X;` can match itself when the
  // file imports its own namespace via `using X;`.
  const selfRel = path.relative(projectRoot, filePath);
  results.delete(selfRel);

  return [...results].sort();
}
