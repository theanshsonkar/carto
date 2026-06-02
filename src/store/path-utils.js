'use strict';

const path = require('path');

/**
 * normalizeFileArg(projectRoot, fileArg) → string
 *
 * Convert a user-provided file path into the canonical form stored in the
 * SQLite `files.path` column: relative-to-project-root, forward-slashed,
 * no leading `./`.
 *
 * Handles every form a user / IDE / shell tab-completion realistically
 * produces:
 *   - relative form already correct          ("lib/application.js"   → "lib/application.js")
 *   - leading "./"                           ("./lib/application.js" → "lib/application.js")
 *   - leading "/" absolute under projectRoot ("/abs/.../lib/application.js" → "lib/application.js")
 *   - Windows backslashes                    ("lib\\application.js"  → "lib/application.js")
 *   - paths containing "../" (e.g. typed from a sibling dir) — resolved.
 *
 * Falsy / empty input returns the input unchanged so the caller's
 * "missing argument" check still fires the same way.
 */
function normalizeFileArg(projectRoot, fileArg) {
  if (typeof fileArg !== 'string' || fileArg.length === 0) return fileArg;

  let p = fileArg;

  // Normalize separators first so the absolute-path check works on Windows.
  p = p.split('\\').join('/');

  // Absolute → relative-to-project-root
  if (path.isAbsolute(p) || /^[a-zA-Z]:\//.test(p)) {
    p = path.relative(projectRoot, p);
    p = p.split(path.sep).join('/');
  }

  // Strip leading "./" (or repeated "./././")
  while (p.startsWith('./')) p = p.slice(2);

  // Resolve any embedded "../" segments without going absolute.
  // e.g. "src/foo/../bar.js" → "src/bar.js"
  if (p.includes('/../') || p.startsWith('../')) {
    const abs = path.resolve(projectRoot, p);
    p = path.relative(projectRoot, abs).split(path.sep).join('/');
  }

  return p;
}

module.exports = { normalizeFileArg };
