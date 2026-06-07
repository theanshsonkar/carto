'use strict';

const fs = require('fs');

/**
 * IGNORE_DIRS — names skipped at the top level when listing project structure.
 *
 * This is intentionally a *small* set tuned for the "Project Structure (auto)"
 * block in AGENTS.md. It is NOT the same as the recursive file-discovery
 * ignore lists (e.g. JS_IGNORE / PYTHON_IGNORE in src/detector/files.js or
 * IGNORE_DIRS in src/store/sync-v2.js) — those filter what gets indexed.
 *
 * Top-level structure should still surface things like `dist/`, `build/`,
 * `coverage/` (so users see what their project actually contains), but it
 * should hide noise (`node_modules`, `.git`, `.carto`, etc.) and the file
 * the structure block is about to be merged into (`AGENTS.md`).
 *
 * Anchored on the original V1 set in src/sync.js so existing AGENTS.md
 * outputs stay stable after the V1 → V2 cleanup.
 */
const IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  '__pycache__',
  '.venv',
  'venv',
  '.idea',
  '.vscode',
  '.carto',
  'AGENTS.md'
]);

/**
 * scanStructure(basePath) → Array<{ name: string, type: 'dir' | 'file' }>
 *
 * Lists the immediate children of `basePath` (one level deep, no recursion).
 * Filters out IGNORE_DIRS. Sorts: directories before files; alphabetical
 * within each group.
 *
 * Symlinks are reported by Dirent as neither dir nor file → treated as 'file'.
 * Failures (missing dir, EACCES, etc.) return an empty array silently — the
 * formatter handles the empty case.
 */
async function scanStructure(basePath) {
  const entries = [];
  let items;
  try {
    items = await fs.promises.readdir(basePath, { withFileTypes: true });
  } catch {
    return entries;
  }

  for (const item of items) {
    if (IGNORE_DIRS.has(item.name)) continue;
    entries.push({
      name: item.name,
      type: item.isDirectory() ? 'dir' : 'file'
    });
  }

  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return entries;
}

module.exports = { scanStructure, IGNORE_DIRS };
