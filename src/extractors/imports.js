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
      // Relative import (behavior unchanged — this path already worked).
      resolvedPath = resolveImportPath(imp, fileDir, projectRoot, ext);
    } else {
      // Non-relative specifier. Try, in order: (1) nearest tsconfig/jsconfig
      // path-aliases, (2) legacy root alias + conventions, (3) the workspace
      // package map (scoped `@scope/pkg[/sub]`, bare workspace names like
      // `ui`/`common`, and barrel entries), (4) nearest tsconfig `baseUrl`
      // bare imports (Next.js `components/...`, `data/...`). Every candidate
      // is existence-checked on disk, so a genuine external npm package
      // (`react`, `next-auth`, …) can never false-resolve to a local file.
      resolvedPath = resolveNonRelativeImport(imp, fileDir, projectRoot);
    }

    if (resolvedPath) {
      const rel = path.isAbsolute(resolvedPath)
        ? path.relative(projectRoot, resolvedPath)
        : resolvedPath;
      resolved.add(rel);
    } else if (isBareModuleSpecifier(imp)) {
      // True external npm package — record as-is (stored with
      // to_file_id = NULL, resolved = 0) so downstream consumers can still
      // see which external packages a file depends on.
      resolved.add(imp);
    }
  }

  return [...resolved].sort();
}

/**
 * Extract import paths from JS/TS content — both relative and aliased.
 * Also captures bare-module specifiers (npm packages like
 * `@supabase/supabase-js`, `next-auth`, `react`) so that consumers can
 * see which external packages a file depends on. Bare specifiers flow
 * through as raw strings; they never resolve to a project-local file
 * and are stored with `to_file_id = NULL, resolved = 0`.
 */
function extractJSImports(content) {
  const imports = [];

  // import ... from 'path' — capture every specifier, prefixed OR bare.
  const importPattern = /import\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g;
  let match;
  while ((match = importPattern.exec(content)) !== null) {
    imports.push(match[1]);
  }

  // Re-exports: `export * from '...'`, `export * as ns from '...'`,
  // `export { a, b } from '...'`, `export type { X } from '...'`.
  // These are genuine dependency edges — they are how barrel files
  // (`packages/ui/index.tsx` → `export * from './src/lib/utils'`) forward
  // a symbol's definition, so blast radius must propagate through them.
  const exportFromPattern =
    /export\s+(?:type\s+)?(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]/g;
  while ((match = exportFromPattern.exec(content)) !== null) {
    imports.push(match[1]);
  }

  // Dynamic imports: `import('...')` (Next.js lazy loading, code-split routes).
  const dynamicImportPattern = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((match = dynamicImportPattern.exec(content)) !== null) {
    imports.push(match[1]);
  }

  // require('...')
  const requirePattern = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((match = requirePattern.exec(content)) !== null) {
    imports.push(match[1]);
  }

  return imports;
}

/**
 * isBareModuleSpecifier(spec) → boolean
 *
 * A "bare" specifier is a package name — not a relative path (`./foo`),
 * not an absolute path (`/foo`), not a path-alias (`@/foo`, `~/foo`,
 * `#/foo` where the single-char prefix is followed immediately by `/`).
 *
 * Scoped packages (`@supabase/supabase-js`, `@clerk/nextjs`) count as
 * bare — the alias prefix is `@/` specifically, not `@scope/`.
 */
function isBareModuleSpecifier(spec) {
  if (!spec || typeof spec !== 'string') return false;
  if (spec.startsWith('.') || spec.startsWith('/')) return false;
  // Path aliases: single-char sigil directly followed by `/`.
  if (spec.startsWith('@/') || spec.startsWith('~/') || spec.startsWith('#/')) return false;
  return true;
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
      // Use the string-aware JSONC parser so a `"$schema": "https://..."`
      // URL (or any `//` inside a string) doesn't corrupt the parse.
      const config = _parseJsonc(raw);
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

// ─── CARTO-001: monorepo workspace / baseUrl / barrel resolution ──────────────
//
// Root cause fixed here: workspace-alias imports (`@scope/pkg/sub`), bare
// workspace names (`ui`, `common`, `ui-patterns`), and Next.js `baseUrl`
// imports (`components/...`) were all classified as external npm packages by
// isBareModuleSpecifier() and dropped from the graph. On alias-heavy
// monorepos that silently discarded ~50-70% of the internal import graph, so
// blast radius, validate_diff, and cross-domain analysis were all computed on
// a gutted graph. The helpers below resolve those specifiers to real project
// files (every candidate is existence-checked), which is all downstream code
// needs — getFileByPath() then maps them to to_file_id and flips resolved=1.

// Extensions probed when resolving a specifier to a file, TS-first.
const _JS_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.d.ts'];

/**
 * Probe an absolute base path for a real file: exact, then +ext, then
 * /index.<ext>. Returns the absolute file path or null.
 */
function _probePath(absBase) {
  try {
    if (fs.existsSync(absBase) && fs.statSync(absBase).isFile()) return absBase;
  } catch { /* ignore */ }
  for (const e of _JS_EXTS) {
    const withExt = absBase + e;
    if (fs.existsSync(withExt)) return withExt;
  }
  for (const e of _JS_EXTS) {
    const idx = path.join(absBase, 'index' + e);
    if (fs.existsSync(idx)) return idx;
  }
  return null;
}

/** Parse JSON with comments + trailing commas (tsconfig/jsconfig tolerate both). */
function _parseJsonc(raw) {
  return JSON.parse(_stripJsonComments(raw).replace(/,(\s*[}\]])/g, '$1'));
}

/**
 * Strip `//` line and block comments from JSON, but NOT when the comment
 * marker appears inside a string literal. A naive regex-based stripper
 * corrupts tsconfigs that carry a `"$schema"` URL like `https:` followed by
 * two slashes — it eats the URL mid-string and makes JSON.parse throw,
 * silently dropping all path aliases (this was the real reason `@/` imports
 * weren't resolving on supabase).
 */
function _stripJsonComments(s) {
  let out = '';
  let inStr = false, strCh = '';
  let inLine = false, inBlock = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i], c2 = s[i + 1];
    if (inLine) { if (c === '\n') { inLine = false; out += c; } continue; }
    if (inBlock) { if (c === '*' && c2 === '/') { inBlock = false; i++; } continue; }
    if (inStr) {
      out += c;
      if (c === '\\') { if (c2 !== undefined) { out += c2; i++; } continue; }
      if (c === strCh) inStr = false;
      continue;
    }
    if (c === '"' || c === "'") { inStr = true; strCh = c; out += c; continue; }
    if (c === '/' && c2 === '/') { inLine = true; i++; continue; }
    if (c === '/' && c2 === '*') { inBlock = true; i++; continue; }
    out += c;
  }
  return out;
}

// ─── Workspace-package map (name → { dir, entry }) ────────────────────────────

const _workspaceCache = new Map(); // projectRoot → { byName:Map, names:[] }
const _WALK_SKIP = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', 'out',
  'coverage', '.turbo', '.cache', '.vercel', 'tmp', '.svelte-kit'
]);

/**
 * Resolve a package.json entry point to a real source file. Tries
 * exports["."] / module / main, then falls back to common source barrels
 * (index.*, src/index.*) so it works on un-built source trees where the
 * declared `main` (e.g. dist/index.js) doesn't exist yet.
 */
function _resolvePackageEntry(pkgDir, pj) {
  const candidates = [];
  const exp = pj && pj.exports;
  if (exp) {
    if (typeof exp === 'string') candidates.push(exp);
    else if (typeof exp === 'object') {
      const dot = exp['.'] !== undefined ? exp['.'] : exp;
      if (typeof dot === 'string') candidates.push(dot);
      else if (dot && typeof dot === 'object') {
        for (const k of ['import', 'module', 'default', 'require', 'node', 'types']) {
          const v = dot[k];
          if (typeof v === 'string') { candidates.push(v); break; }
          if (v && typeof v === 'object' && typeof v.default === 'string') { candidates.push(v.default); break; }
        }
      }
    }
  }
  if (typeof pj?.module === 'string') candidates.push(pj.module);
  if (typeof pj?.main === 'string') candidates.push(pj.main);
  // Source-tree fallbacks (order matters — prefer explicit barrels).
  candidates.push('index', 'src/index', 'src/main', 'lib/index');

  for (const c of candidates) {
    if (!c) continue;
    const hit = _probePath(path.resolve(pkgDir, c.replace(/^\.\//, '')));
    if (hit) return hit;
  }
  return null;
}

/**
 * Build the workspace-package map for a repo: every package.json with a
 * `name`, mapped to its directory + resolved barrel entry. Uses a bounded
 * directory walk (skipping node_modules/build dirs) so it works whether the
 * repo declares workspaces via root package.json `workspaces`, a
 * pnpm-workspace.yaml, or nothing at all. Cached per projectRoot.
 */
function loadWorkspaceMap(projectRoot) {
  if (_workspaceCache.has(projectRoot)) return _workspaceCache.get(projectRoot);

  const byName = new Map();
  const MAX_DEPTH = 7;

  const consider = (dir) => {
    const pjPath = path.join(dir, 'package.json');
    let pj;
    try { pj = JSON.parse(fs.readFileSync(pjPath, 'utf-8')); } catch { return; }
    if (pj && typeof pj.name === 'string' && pj.name) {
      if (!byName.has(pj.name)) {
        byName.set(pj.name, { dir, entry: _resolvePackageEntry(dir, pj) });
      }
    }
  };

  const walk = (dir, depth) => {
    if (depth > MAX_DEPTH) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    let hasPkg = false;
    for (const e of entries) {
      if (e.isFile() && e.name === 'package.json') hasPkg = true;
    }
    if (hasPkg) consider(dir);
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith('.') || _WALK_SKIP.has(e.name)) continue;
      walk(path.join(dir, e.name), depth + 1);
    }
  };

  walk(projectRoot, 0);

  // Longest names first so `@scope/pkg` wins over a hypothetical `@scope`.
  const names = [...byName.keys()].sort((a, b) => b.length - a.length);
  const map = { byName, names };
  _workspaceCache.set(projectRoot, map);
  return map;
}

/**
 * Resolve a specifier against the workspace-package map.
 *   - exact package name (`ui`, `@supabase/pg-meta`) → its barrel entry
 *     (so blast radius propagates through re-export barrels), falling back
 *     to the package dir's index if no entry was resolvable.
 *   - subpath (`@calcom/trpc/server/types`, `common/hooks`) →
 *     `<pkgDir>/<sub>` or `<pkgDir>/src/<sub>`.
 * Returns an absolute file path or null.
 */
function resolveWorkspaceImport(imp, projectRoot) {
  const wm = loadWorkspaceMap(projectRoot);
  if (wm.names.length === 0) return null;

  for (const name of wm.names) {
    if (imp === name) {
      const { dir, entry } = wm.byName.get(name);
      return entry || _probePath(path.join(dir, 'index')) || _probePath(path.join(dir, 'src/index'));
    }
    if (imp.startsWith(name + '/')) {
      const { dir } = wm.byName.get(name);
      const sub = imp.slice(name.length + 1);
      return _probePath(path.join(dir, sub)) || _probePath(path.join(dir, 'src', sub));
    }
  }
  return null;
}

// ─── Nearest tsconfig/jsconfig chain (paths + baseUrl) ────────────────────────

const _tsconfigParseCache = new Map();  // configPath → { aliases:Map<prefix,[absDir]>, baseUrlDir|null }
const _nearestTsconfigCache = new Map(); // startDir → parsed chain | null

/** Resolve a tsconfig `extends` target to an absolute config path. */
function _resolveExtends(ext, fromDir, projectRoot) {
  if (!ext || typeof ext !== 'string') return null;
  let target;
  if (ext.startsWith('.')) {
    target = path.resolve(fromDir, ext);
  } else {
    // Bare `pkg[/sub]` — resolve against the workspace map (e.g. supabase's
    // `tsconfig/nextjs.json`). node_modules-only extends are ignored (their
    // configs rarely add local paths and aren't present in source trees).
    const wm = loadWorkspaceMap(projectRoot);
    const slash = ext.indexOf('/');
    const pkg = slash === -1 ? ext : ext.slice(0, slash);
    const sub = slash === -1 ? '' : ext.slice(slash + 1);
    const rec = wm.byName.get(pkg);
    if (!rec) return null;
    target = sub ? path.join(rec.dir, sub) : path.join(rec.dir, 'tsconfig.json');
  }
  if (!/\.json$/.test(target)) target += '.json';
  return fs.existsSync(target) ? target : null;
}

/**
 * Parse a tsconfig/jsconfig (following `extends`) into absolute path-alias
 * targets + an absolute baseUrl dir (only when baseUrl is explicitly set —
 * TS only resolves bare specifiers against baseUrl when it's declared).
 */
function _parseTsconfigChain(configPath, projectRoot, seen) {
  if (_tsconfigParseCache.has(configPath)) return _tsconfigParseCache.get(configPath);
  seen = seen || new Set();
  if (seen.has(configPath)) return { aliases: new Map(), baseUrlDir: null };
  seen.add(configPath);

  let cfg;
  try { cfg = _parseJsonc(fs.readFileSync(configPath, 'utf-8')); } catch { cfg = {}; }
  const dir = path.dirname(configPath);

  let aliases = new Map();
  let baseUrlDir = null;

  if (cfg.extends) {
    const extList = Array.isArray(cfg.extends) ? cfg.extends : [cfg.extends];
    for (const ex of extList) {
      const parentPath = _resolveExtends(ex, dir, projectRoot);
      if (parentPath) {
        const parent = _parseTsconfigChain(parentPath, projectRoot, seen);
        for (const [k, v] of parent.aliases) aliases.set(k, v);
        if (parent.baseUrlDir) baseUrlDir = parent.baseUrlDir;
      }
    }
  }

  const co = cfg.compilerOptions || {};
  // baseUrl is resolved relative to THIS config's directory.
  const ownBaseUrlDir = co.baseUrl !== undefined ? path.resolve(dir, co.baseUrl) : path.resolve(dir);
  if (co.baseUrl !== undefined) baseUrlDir = ownBaseUrlDir;

  if (co.paths && typeof co.paths === 'object') {
    for (const [pattern, targets] of Object.entries(co.paths)) {
      if (!Array.isArray(targets) || targets.length === 0) continue;
      const prefix = pattern.replace(/\*$/, '');
      const absTargets = targets.map(t =>
        path.resolve(ownBaseUrlDir, String(t).replace(/\*$/, '')));
      aliases.set(prefix, absTargets);
    }
  }

  const result = { aliases, baseUrlDir };
  _tsconfigParseCache.set(configPath, result);
  return result;
}

/** Find + parse the nearest tsconfig/jsconfig walking up from a directory. */
function _getTsconfigForDir(startDir, projectRoot) {
  if (_nearestTsconfigCache.has(startDir)) return _nearestTsconfigCache.get(startDir);

  let dir = startDir;
  let configPath = null;
  while (dir && dir.startsWith(projectRoot)) {
    for (const name of ['tsconfig.json', 'jsconfig.json']) {
      const p = path.join(dir, name);
      if (fs.existsSync(p)) { configPath = p; break; }
    }
    if (configPath) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  const result = configPath ? _parseTsconfigChain(configPath, projectRoot) : null;
  _nearestTsconfigCache.set(startDir, result);
  return result;
}

/** Resolve `imp` against the nearest tsconfig `paths` aliases. */
function resolveTsconfigPaths(imp, fileDir, projectRoot) {
  const chain = _getTsconfigForDir(fileDir, projectRoot);
  if (!chain || chain.aliases.size === 0) return null;
  // Longest prefix first for correctness (`@ui/` before `@/`).
  const prefixes = [...chain.aliases.keys()].sort((a, b) => b.length - a.length);
  for (const prefix of prefixes) {
    const isWildcard = prefix.endsWith('/') || prefix === '';
    const matches = isWildcard ? imp.startsWith(prefix) : imp === prefix;
    if (!matches) continue;
    const rest = imp.slice(prefix.length);
    for (const targetDir of chain.aliases.get(prefix)) {
      const hit = _probePath(rest ? path.join(targetDir, rest) : targetDir);
      if (hit) return hit;
    }
  }
  return null;
}

/** Resolve a bare `imp` against the nearest tsconfig `baseUrl` (Next.js style). */
function resolveBaseUrlImport(imp, fileDir, projectRoot) {
  const chain = _getTsconfigForDir(fileDir, projectRoot);
  if (!chain || !chain.baseUrlDir) return null;
  return _probePath(path.join(chain.baseUrlDir, imp));
}

/**
 * Resolve a non-relative JS/TS specifier to a project file, or null if it's a
 * genuine external package. Order: tsconfig paths → legacy root alias/
 * conventions → workspace-package map → tsconfig baseUrl.
 */
function resolveNonRelativeImport(imp, fileDir, projectRoot) {
  let r = resolveTsconfigPaths(imp, fileDir, projectRoot);
  if (r) return r;

  const aliasedAbs = resolveAliasedImport(imp, projectRoot);
  if (aliasedAbs) {
    r = _probePath(aliasedAbs);
    if (r) return r;
  }

  r = resolveWorkspaceImport(imp, projectRoot);
  if (r) return r;

  r = resolveBaseUrlImport(imp, fileDir, projectRoot);
  if (r) return r;

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

module.exports = { extractImports, buildImportGraph, resolveSpecifier };

/**
 * resolveSpecifier(spec, fromFileRel, projectRoot) → project-relative path | null
 *
 * Resolve a single import specifier (as written in source) to the
 * project-relative path of the file it points to, or null if it's a
 * genuine external package / unresolvable. Shared with validate_diff so
 * the guardrail resolves the *same* workspace-alias / baseUrl / barrel
 * specifiers the indexer does (CARTO-002) — otherwise a newly-added
 * `import { x } from 'ui'` crossing a domain boundary would slip past as
 * SAFE just because it isn't a relative path.
 */
function resolveSpecifier(spec, fromFileRel, projectRoot) {
  if (!spec || typeof spec !== 'string' || !projectRoot) return null;
  const fromAbsDir = path.dirname(path.resolve(projectRoot, fromFileRel));
  const sourceExt = path.extname(fromFileRel).toLowerCase();
  let abs;
  if (spec.startsWith('.')) {
    abs = resolveImportPath(spec, fromAbsDir, projectRoot, sourceExt);
  } else {
    abs = resolveNonRelativeImport(spec, fromAbsDir, projectRoot);
  }
  if (!abs) return null;
  const rel = path.isAbsolute(abs) ? path.relative(projectRoot, abs) : abs;
  return rel.split(path.sep).join('/');
}

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
