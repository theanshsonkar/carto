'use strict';

/**
 * Semantic diff — beyond line-by-line.
 *
 * Detects:
 *   1. Renames — `function getUser()` → `function getUserById()` in the
 *      same file (same surrounding signature shape).
 *   2. Symbol relocation — symbol disappears from file A, appears in file
 *      B with the same name.
 *   3. New domain introduction — a path prefix appears for the first time
 *      among added files.
 *   4. Architectural-change signal — added imports cross domain boundaries
 *      vs existing edges (delegates to validateDiff).
 *
 * Input: a unified diff (string). Output: structured findings the AI can
 * present in PR comments.
 */

const { parseDiff: parseUnifiedDiff } = require('../mcp/diff-parser');

/**
 * semanticDiff({ store, diff }) → { renames, relocations, new_domains,
 *                                    new_files, deleted_files }
 *
 * `store` provides knowledge about file→domain assignment so we can
 * detect when a brand-new path prefix introduces a fresh domain.
 */
function semanticDiff({ store, diff }) {
  const parsed = parseUnifiedDiff(diff || '');
  const renames = detectRenames(parsed);
  const relocations = detectRelocations(parsed);
  const newDomains = detectNewDomains(parsed, store);
  return {
    renames,
    relocations,
    new_domains: newDomains,
    new_files: parsed.filter(p => p.kind === 'add').map(p => p.path),
    deleted_files: parsed.filter(p => p.kind === 'delete').map(p => p.path),
    files_changed: parsed.length,
  };
}

/**
 * detectRenames — within a single file, find pairs of removed-then-added
 * function/class declarations whose body is similar. Cheap heuristic:
 * compare the surrounding line shape — only one identifier should differ.
 *
 * Input: file entries with `added: [{ lineNo, content }]` and
 * `removed: [{ lineNo, content }]` as produced by `parseDiff`.
 */
function detectRenames(files) {
  const out = [];
  for (const f of files) {
    if (f.kind !== 'modify') continue;
    const removedFns = [];
    const addedFns = [];
    for (const r of (f.removed || [])) {
      const m = /\b(?:function|def|fn|fun|public|private)\s+(\w+)\s*\(/.exec(r.content);
      if (m) removedFns.push({ name: m[1], line: r.content });
    }
    for (const a of (f.added || [])) {
      const m = /\b(?:function|def|fn|fun|public|private)\s+(\w+)\s*\(/.exec(a.content);
      if (m) addedFns.push({ name: m[1], line: a.content });
    }
    for (const r of removedFns) {
      for (const a of addedFns) {
        if (r.name === a.name) continue;
        const rNoName = r.line.replace(r.name, '__NAME__');
        const aNoName = a.line.replace(a.name, '__NAME__');
        if (rNoName === aNoName) {
          out.push({ file: f.path, from: r.name, to: a.name });
          break;
        }
      }
    }
  }
  return out;
}

/**
 * detectRelocations — same-name function disappearing from one file +
 * appearing in another.
 */
function detectRelocations(files) {
  const removedByName = new Map();
  const addedByName = new Map();
  for (const f of files) {
    for (const r of (f.removed || [])) {
      const m = /\b(?:function|def|fn|fun)\s+(\w+)\s*\(/.exec(r.content);
      if (m) {
        if (!removedByName.has(m[1])) removedByName.set(m[1], []);
        removedByName.get(m[1]).push(f.path);
      }
    }
    for (const a of (f.added || [])) {
      const m = /\b(?:function|def|fn|fun)\s+(\w+)\s*\(/.exec(a.content);
      if (m) {
        if (!addedByName.has(m[1])) addedByName.set(m[1], []);
        addedByName.get(m[1]).push(f.path);
      }
    }
  }
  const out = [];
  for (const [name, removedFiles] of removedByName) {
    const addedFiles = addedByName.get(name);
    if (!addedFiles) continue;
    for (const r of removedFiles) {
      for (const a of addedFiles) {
        if (r !== a) out.push({ symbol: name, from_file: r, to_file: a });
      }
    }
  }
  return out;
}

/**
 * detectNewDomains — added files whose path prefix doesn't match any
 * existing domain assignment in the store.
 */
function detectNewDomains(files, store) {
  if (!store || !store.db) return [];
  const out = new Set();
  const existingPrefixes = new Set();
  try {
    const rows = store.db.prepare('SELECT path FROM files').all();
    for (const r of rows) {
      const parts = r.path.split('/');
      if (parts.length >= 2) existingPrefixes.add(parts.slice(0, 2).join('/'));
    }
  } catch { return []; }
  for (const f of files) {
    if (f.kind !== 'add') continue;
    const parts = (f.path || '').split('/');
    if (parts.length >= 2) {
      const prefix = parts.slice(0, 2).join('/');
      if (!existingPrefixes.has(prefix)) out.add(prefix);
    }
  }
  return [...out];
}

module.exports = { semanticDiff, detectRenames, detectRelocations, detectNewDomains };
