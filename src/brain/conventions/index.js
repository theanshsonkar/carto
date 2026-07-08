'use strict';

/**
 * Semantic Memory — convention learning.
 *
 * Mines conventions from the static index:
 *   - Identifier-case naming per directory + extension (PascalCase components,
 *     camelCase utils, kebab-case files, …) — the actionable one for scaffolding.
 *   - File naming suffix patterns per directory (e.g. *.service.ts, *.config.*)
 *   - Export style (default vs named) per domain
 *   - Directory language (e.g. src/* is all TypeScript)
 *
 * Each convention carries a `confidence` (0–1) and a derived `strength`
 * (`high` ≥ 0.9, `medium` ≥ threshold). By default only conventions at or
 * above `threshold` (0.75) are returned, so the caller never sees a rule the
 * evidence doesn't support. When nothing clears the bar the caller gets an
 * empty list and the formatter says so honestly, rather than emitting a
 * misleading low-confidence "rule".
 *
 * Consumed by:
 *   - `get_conventions(file_or_dir)` — what conventions apply to this file
 *   - `scaffold_for_intent(intent)` — what scaffold to follow
 */

const path = require('path');

const DEFAULT_THRESHOLD = 0.75;
const MIN_EVIDENCE = 4; // need at least this many files before a pattern is a "convention"

function strengthOf(conf) {
  return conf >= 0.9 ? 'high' : 'medium';
}

/**
 * Classify an identifier (a filename without its extension) into a case style.
 * Returns null for names we don't want to vote on (empty, dotfiles, purely
 * numeric, or single ambiguous lowercase words like `index`/`utils` that carry
 * no style signal).
 */
function classifyCase(name) {
  if (!name) return null;
  // Strip a leading dot for dotfiles like `.eslintrc` — no naming signal.
  if (name.startsWith('.')) return null;
  if (/^\d+$/.test(name)) return null;

  if (name.includes('-') && /^[a-z0-9]+(-[a-z0-9]+)+$/.test(name)) return 'kebab-case';
  if (name.includes('_') && /^[a-z0-9]+(_[a-z0-9]+)+$/.test(name)) return 'snake_case';
  // PascalCase: starts uppercase, has a lowercase letter somewhere (excludes
  // SCREAMING_CONST-style and single-letter tokens).
  if (/^[A-Z][A-Za-z0-9]*$/.test(name) && /[a-z]/.test(name)) return 'PascalCase';
  // camelCase: starts lowercase, has at least one uppercase hump.
  if (/^[a-z][A-Za-z0-9]*$/.test(name) && /[A-Z]/.test(name)) return 'camelCase';
  // Single all-lowercase word (index, utils, types, page) — ambiguous, skip.
  return null;
}

/**
 * mineConventions(store, opts) → Array<convention>
 *
 * Each convention:
 *   { id, kind, scope, rule, confidence, strength, evidence_count, ext? }
 */
function mineConventions(store, { threshold = DEFAULT_THRESHOLD } = {}) {
  if (!store || !store.db) return [];
  const out = [];
  out.push(...mineCaseStyleConventions(store, { threshold }));
  out.push(...mineNamingConventions(store, { threshold }));
  out.push(...mineExportConventions(store, { threshold }));
  out.push(...mineDirectoryConventions(store, { threshold }));
  return out;
}

/**
 * Per (directory, extension): the dominant identifier-case of the file names.
 * This is the convention an AI actually needs when it's told "add a component
 * to apps/studio/components/grid" — it should learn those files are PascalCase
 * .tsx, not merely that the directory is "typescript".
 */
function mineCaseStyleConventions(store, { threshold }) {
  const rows = store.db.prepare('SELECT path FROM files').all();
  // Map<dir, Map<ext, Map<style, count>>> plus a classified-total per (dir,ext).
  const byDirExt = new Map();
  for (const r of rows) {
    const dir = path.posix.dirname(r.path);
    const base = path.posix.basename(r.path);
    const ext = path.posix.extname(base); // includes leading dot, '' if none
    const stem = ext ? base.slice(0, -ext.length) : base;
    const style = classifyCase(stem);
    if (!style) continue;
    if (!byDirExt.has(dir)) byDirExt.set(dir, new Map());
    const extMap = byDirExt.get(dir);
    if (!extMap.has(ext)) extMap.set(ext, new Map());
    const styleMap = extMap.get(ext);
    styleMap.set(style, (styleMap.get(style) || 0) + 1);
  }

  const out = [];
  for (const [dir, extMap] of byDirExt) {
    for (const [ext, styleMap] of extMap) {
      const total = Array.from(styleMap.values()).reduce((a, b) => a + b, 0);
      if (total < MIN_EVIDENCE) continue;
      let topStyle = null, topCount = 0;
      for (const [style, c] of styleMap) {
        if (c > topCount) { topStyle = style; topCount = c; }
      }
      const conf = topCount / total;
      if (conf < threshold) continue;
      const extLabel = ext || '(no ext)';
      out.push({
        id: `case_${dir}_${ext}_${topStyle}`,
        kind: 'naming_case',
        scope: dir,
        ext,
        rule: `${extLabel} files in ${dir}/ are typically named ${topStyle} (${topCount}/${total}).`,
        confidence: Math.round(conf * 100) / 100,
        strength: strengthOf(conf),
        evidence_count: topCount,
      });
    }
  }
  return out;
}

function mineNamingConventions(store, { threshold }) {
  // Look for filename suffix patterns within each directory.
  // E.g. if 8/10 files in src/services match *.service.ts → convention.
  const rows = store.db.prepare('SELECT path FROM files').all();
  const byDir = new Map();
  for (const r of rows) {
    const dir = path.posix.dirname(r.path);
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push(path.posix.basename(r.path));
  }

  const out = [];
  for (const [dir, files] of byDir) {
    if (files.length < MIN_EVIDENCE) continue;
    // Count suffix patterns: tokenize on '.' from the end, look for the
    // second-from-last token (`*.service.ts` → 'service').
    const suffixCounts = new Map();
    for (const f of files) {
      const parts = f.split('.');
      if (parts.length < 3) continue;
      const suffix = parts[parts.length - 2];
      suffixCounts.set(suffix, (suffixCounts.get(suffix) || 0) + 1);
    }
    for (const [suffix, count] of suffixCounts) {
      const conf = count / files.length;
      if (conf >= threshold) {
        out.push({
          id: `naming_${dir}_${suffix}`,
          kind: 'filename_suffix',
          scope: dir,
          rule: `Files in ${dir}/ typically match *.${suffix}.* (${count}/${files.length}).`,
          confidence: Math.round(conf * 100) / 100,
          strength: strengthOf(conf),
          evidence_count: count,
        });
      }
    }
  }
  return out;
}

function mineExportConventions(store, { threshold }) {
  // Per-domain default vs named export ratio.
  const rows = store.db.prepare(`
    SELECT d.name as domain_name,
           SUM(s.is_default_export) as defaults,
           COUNT(s.id) as total
    FROM files f
    JOIN domains d ON f.domain_id = d.id
    JOIN symbols s ON s.file_id = f.id
    WHERE s.exported = 1
    GROUP BY d.name
  `).all();

  const out = [];
  for (const r of rows) {
    if (r.total < 5) continue;
    const defaultRatio = (r.defaults || 0) / r.total;
    if (defaultRatio >= threshold) {
      out.push({
        id: `export_${r.domain_name}_default`,
        kind: 'export_style',
        scope: r.domain_name,
        rule: `${r.domain_name} files typically use default exports (${r.defaults}/${r.total}).`,
        confidence: Math.round(defaultRatio * 100) / 100,
        strength: strengthOf(defaultRatio),
        evidence_count: r.defaults,
      });
    } else if ((1 - defaultRatio) >= threshold) {
      const namedRatio = 1 - defaultRatio;
      const named = r.total - (r.defaults || 0);
      out.push({
        id: `export_${r.domain_name}_named`,
        kind: 'export_style',
        scope: r.domain_name,
        rule: `${r.domain_name} files typically use named exports (${named}/${r.total}).`,
        confidence: Math.round(namedRatio * 100) / 100,
        strength: strengthOf(namedRatio),
        evidence_count: named,
      });
    }
  }
  return out;
}

function mineDirectoryConventions(store, { threshold }) {
  // For each first-level directory, check if all child dirs share a
  // single language (e.g. src/* is all TypeScript). The conventions here
  // are coarse — useful when AI is told to add a file and needs to know
  // what extension to use.
  const rows = store.db.prepare(`
    SELECT path, language FROM files WHERE language IS NOT NULL
  `).all();

  const byDir = new Map();
  for (const r of rows) {
    const parts = r.path.split('/');
    if (parts.length < 2) continue;
    const prefix = parts[0];
    if (!byDir.has(prefix)) byDir.set(prefix, new Map());
    const langs = byDir.get(prefix);
    langs.set(r.language, (langs.get(r.language) || 0) + 1);
  }

  const out = [];
  for (const [prefix, langs] of byDir) {
    const total = Array.from(langs.values()).reduce((a, b) => a + b, 0);
    if (total < 5) continue;
    let topLang = null, topCount = 0;
    for (const [lang, c] of langs) {
      if (c > topCount) { topLang = lang; topCount = c; }
    }
    const conf = topCount / total;
    if (conf >= threshold) {
      out.push({
        id: `dir_lang_${prefix}_${topLang}`,
        kind: 'directory_language',
        scope: prefix,
        rule: `${prefix}/ is predominantly ${topLang} (${topCount}/${total}).`,
        confidence: Math.round(conf * 100) / 100,
        strength: strengthOf(conf),
        evidence_count: topCount,
      });
    }
  }
  return out;
}

/**
 * True when `filePath` lives in directory `scope` or any subdirectory of it.
 */
function underScope(filePath, scope) {
  const dir = path.posix.dirname(filePath);
  return dir === scope || dir.startsWith(scope + '/');
}

/**
 * conventionsForFile(store, filePath, opts) → Array<convention>
 *
 * Returns the subset of conventions whose `scope` matches `filePath`, sorted by
 * confidence (desc) so the strongest, most specific guidance comes first.
 * Used by `get_conventions(file_or_dir)`.
 */
function conventionsForFile(store, filePath, opts = {}) {
  if (!filePath) return [];
  const all = mineConventions(store, opts);
  const ext = path.posix.extname(filePath);
  const matched = all.filter(c => {
    if (c.kind === 'naming_case') {
      // Match same-extension case conventions in this dir or an ancestor dir.
      return (!c.ext || c.ext === ext) && underScope(filePath, c.scope);
    }
    if (c.kind === 'filename_suffix') return underScope(filePath, c.scope);
    if (c.kind === 'directory_language') return filePath.startsWith(c.scope + '/');
    if (c.kind === 'export_style') {
      // Match if the file belongs to the domain in `scope`.
      const domain = store.getDomainOf ? store.getDomainOf(filePath) : null;
      if (domain) return domain === c.scope;
      // Fallback for older stores without getDomainOf.
      const file = store.getFileByPath(filePath);
      if (!file || !file.domain_id) return false;
      const d = store.db.prepare('SELECT name FROM domains WHERE id = ?').get(file.domain_id);
      return d && d.name === c.scope;
    }
    return false;
  });
  matched.sort((a, b) => (b.confidence - a.confidence));
  return matched;
}

module.exports = {
  mineConventions,
  conventionsForFile,
  classifyCase,
  DEFAULT_THRESHOLD,
};
