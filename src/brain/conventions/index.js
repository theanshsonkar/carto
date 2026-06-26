'use strict';

/**
 * Semantic Memory — convention learning.
 *
 * Mines conventions from the static index:
 *   - File naming patterns per directory (e.g. *.service.ts)
 *   - Import bundles that co-occur (e.g. `useState` always with `useEffect`)
 *   - Export style (default vs named) per domain
 *   - Domain co-location (file X and file Y always live in same domain)
 *
 * Each convention has a confidence score; only conventions with confidence
 * >= 0.75 are returned by default.
 *
 * Consumed by:
 *   - `get_conventions(file_or_dir)` — what conventions apply to this file
 *   - `scaffold_for_intent(intent)` — what scaffold to follow
 */

const path = require('path');

const DEFAULT_THRESHOLD = 0.75;

/**
 * mineConventions(store, opts) → Array<convention>
 *
 * Each convention:
 *   { id, kind, scope, rule, confidence, evidence_count }
 */
function mineConventions(store, { threshold = DEFAULT_THRESHOLD } = {}) {
  if (!store || !store.db) return [];
  const out = [];
  out.push(...mineNamingConventions(store, { threshold }));
  out.push(...mineExportConventions(store, { threshold }));
  out.push(...mineDirectoryConventions(store, { threshold }));
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
    if (files.length < 4) continue;
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
          rule: `Files in ${dir}/ typically match *.${suffix}.*`,
          confidence: Math.round(conf * 100) / 100,
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
        rule: `${r.domain_name} files typically use default exports.`,
        confidence: Math.round(defaultRatio * 100) / 100,
        evidence_count: r.defaults,
      });
    } else if ((1 - defaultRatio) >= threshold) {
      out.push({
        id: `export_${r.domain_name}_named`,
        kind: 'export_style',
        scope: r.domain_name,
        rule: `${r.domain_name} files typically use named exports.`,
        confidence: Math.round((1 - defaultRatio) * 100) / 100,
        evidence_count: r.total - (r.defaults || 0),
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
        rule: `${prefix}/ is predominantly ${topLang}.`,
        confidence: Math.round(conf * 100) / 100,
        evidence_count: topCount,
      });
    }
  }
  return out;
}

/**
 * conventionsForFile(store, filePath, opts) → Array<convention>
 *
 * Returns the subset of conventions whose `scope` matches `filePath`.
 * Used by `get_conventions(file_or_dir)`.
 */
function conventionsForFile(store, filePath, opts = {}) {
  if (!filePath) return [];
  const all = mineConventions(store, opts);
  const dir = path.posix.dirname(filePath);
  return all.filter(c => {
    if (c.kind === 'filename_suffix') return c.scope === dir;
    if (c.kind === 'directory_language') return filePath.startsWith(c.scope + '/');
    if (c.kind === 'export_style') {
      // Match if the file belongs to the domain in `scope`.
      const file = store.getFileByPath(filePath);
      if (!file || !file.domain_id) return false;
      const domain = store.db.prepare('SELECT name FROM domains WHERE id = ?').get(file.domain_id);
      return domain && domain.name === c.scope;
    }
    return false;
  });
}

module.exports = { mineConventions, conventionsForFile, DEFAULT_THRESHOLD };
