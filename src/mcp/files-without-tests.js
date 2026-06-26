'use strict';

/**
 * Files-Without-Tests detector.
 *
 * Given a list of file paths (typically the union blast radius of a
 * PR's diff), scan each one's *immediate filesystem neighborhood* for a
 * sibling test file. Files with no detectable test sibling are returned
 * as the "without-tests" set — that's the metric the PR comment surfaces.
 *
 * Deliberately conservative:
 *   - Never goes up more than one directory level.
 *   - Patterns are limited to per-language conventions that are widely
 *     followed; anything more aggressive produces false negatives that
 *     undermine the metric.
 *   - Files that don't look like source code (config, docs, images) are
 *     excluded — they don't need tests in the first place.
 *
 * Trade-off: a few false positives (file X has tests in a far-away
 * `tests/` directory we didn't walk) are acceptable. The PR comment shows
 * the number, not a witch-hunt list — reviewers can verify by eyeballing
 * the names.
 *
 * Detection rules per file extension:
 *
 *   JS/TS (.js .jsx .ts .tsx .mjs .cjs):
 *     - <base>.test.<ext> or <base>.spec.<ext> in the same dir
 *     - __tests__/<base>.test.<ext> in the parent dir
 *
 *   Python (.py):
 *     - test_<base>.py or <base>_test.py in the same dir
 *     - tests/test_<base>.py one level up
 *
 *   Go (.go):
 *     - <base>_test.go in the same dir (the Go-blessed convention)
 *
 *   Rust (.rs):
 *     - tests/<base>.rs one level up (the Cargo convention)
 *     - Inline `#[cfg(test)]` blocks are intentionally not detected — that
 *       would require reading file content; an acceptable gap for now.
 *
 *   Java (.java), C# (.cs), Kotlin (.kt), Ruby (.rb), C/C++ (.c, .cpp,
 *   .cc, .cxx, .h, .hpp):
 *     - Conventions vary too much across projects (src/test/java vs
 *       adjacent vs separate test repo). Returns "has tests" as UNKNOWN
 *       so those files don't count toward the without-tests metric.
 *       Keeps false positives low.
 *
 * Excluded entirely (don't appear in the metric):
 *   - Test fixture files (already a test): *.test.* *.spec.* *_test.* test_*.*
 *   - Non-source files: .md .yml .yaml .json .toml .lock .png .svg .html
 *   - .d.ts type-only declarations
 *   - Index barrels (`index.ts`, `index.js`) — typically just re-exports
 */

const fs = require('fs');
const path = require('path');

const NON_SOURCE_EXTS = new Set([
  '.md', '.markdown', '.txt',
  '.yml', '.yaml', '.json', '.toml', '.ini', '.env',
  '.lock', '.lockb',
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico',
  '.html', '.htm', '.css', '.scss', '.sass', '.less',
  '.gitignore', '.gitattributes', '.editorconfig',
  '.sql', '.csv', '.tsv',
  '.sh', '.bash', '.zsh', '.fish',
  '.prisma', '.graphql', '.proto',
]);

// Filenames that are likely barrels/re-exports — counting them
// as "without tests" creates noise. Strip the dir-default barrel set.
const SKIP_BASENAMES = new Set(['index']);

/**
 * isTestFile(file) — true when the file itself IS a test (not a candidate).
 */
function isTestFile(file) {
  const base = path.posix.basename(file);
  if (/\.(test|spec|stories)\./.test(base)) return true;
  if (/^test_.+\.py$/.test(base)) return true;
  if (/_test\.(go|py|ts|tsx|js|jsx|rs)$/.test(base)) return true;
  return false;
}

/**
 * isNonSourceFile(file) — true when the file's extension means it doesn't
 * need a test. (Markdown, JSON, images, etc.) Type-only TS declarations
 * are also excluded.
 */
function isNonSourceFile(file) {
  const base = path.posix.basename(file);
  if (base.endsWith('.d.ts')) return true;
  const ext = path.posix.extname(base).toLowerCase();
  if (NON_SOURCE_EXTS.has(ext)) return true;
  // Files with no extension are usually scripts/configs — exclude.
  if (!ext) return true;
  return false;
}

/**
 * isIgnoredBasename(file) — true when this file is a barrel index that
 * we don't expect to have unit tests.
 */
function isIgnoredBasename(file) {
  const base = path.posix.basename(file);
  const dot = base.indexOf('.');
  const stem = dot >= 0 ? base.slice(0, dot) : base;
  return SKIP_BASENAMES.has(stem);
}

/**
 * stemOf(file) → string
 *
 * Returns the filename stem with all extensions stripped, e.g.
 *   "src/auth/login.test.ts" → "login"
 *   "src/auth/login.ts"      → "login"
 *   "user_test.go"           → "user"
 *   "test_user.py"           → "user"
 */
function stemOf(file) {
  let base = path.posix.basename(file);
  // Strip leading "test_" (Python convention).
  if (base.startsWith('test_')) base = base.slice(5);
  // Strip first dot-suffix (handles .test.ts → leaves bare name).
  const firstDot = base.indexOf('.');
  if (firstDot > 0) base = base.slice(0, firstDot);
  // Strip trailing "_test" (Go / Python convention).
  if (base.endsWith('_test')) base = base.slice(0, -5);
  return base;
}

/**
 * Cached directory listing — checking dozens of candidate paths per
 * file would issue too many syscalls. One readdir per dir, reused.
 */
function buildListingCache() {
  const cache = new Map();
  return {
    list(absDir) {
      if (cache.has(absDir)) return cache.get(absDir);
      let entries = [];
      try {
        entries = fs.readdirSync(absDir);
      } catch {
        entries = [];
      }
      cache.set(absDir, entries);
      return entries;
    },
  };
}

/**
 * hasTestSibling(projectRoot, relPath, listing) → boolean | null
 *
 * Returns:
 *   - true   if a test sibling was detected
 *   - false  if the file is a testable source file and no sibling found
 *   - null   if the file is not testable (test itself, non-source,
 *            convention not understood) — caller should skip in metric
 */
function hasTestSibling(projectRoot, relPath, listing) {
  if (isTestFile(relPath)) return null;
  if (isNonSourceFile(relPath)) return null;
  if (isIgnoredBasename(relPath)) return null;

  const ext = path.posix.extname(relPath).toLowerCase();
  const stem = stemOf(relPath);
  const dir = path.posix.dirname(relPath);
  const parent = dir === '.' ? '' : path.posix.dirname(dir);

  const sameDir = listing.list(path.join(projectRoot, dir));
  const parentDir = listing.list(parent ? path.join(projectRoot, parent) : projectRoot);

  // Helper: is there a file matching `predicate` in `entries`?
  const any = (entries, predicate) => {
    for (const e of entries) {
      if (predicate(e)) return true;
    }
    return false;
  };

  switch (ext) {
    case '.js': case '.jsx': case '.mjs': case '.cjs':
    case '.ts': case '.tsx': {
      // sibling: <stem>.test.<ext> | <stem>.spec.<ext>
      const re = new RegExp(`^${escapeRegex(stem)}\\.(test|spec)\\.(js|jsx|mjs|cjs|ts|tsx)$`);
      if (any(sameDir, (e) => re.test(e))) return true;
      // __tests__/<stem>.test.<ext> in same dir
      try {
        const testsDir = listing.list(path.join(projectRoot, dir, '__tests__'));
        if (any(testsDir, (e) => re.test(e))) return true;
      } catch { /* ignore */ }
      return false;
    }

    case '.py': {
      // test_<stem>.py | <stem>_test.py in same dir
      if (any(sameDir, (e) => e === `test_${stem}.py` || e === `${stem}_test.py`)) return true;
      // tests/test_<stem>.py one level up
      try {
        const testsDir = listing.list(parent ? path.join(projectRoot, parent, 'tests') : path.join(projectRoot, 'tests'));
        if (any(testsDir, (e) => e === `test_${stem}.py`)) return true;
      } catch { /* ignore */ }
      // sibling tests/ in same dir
      try {
        const testsDir = listing.list(path.join(projectRoot, dir, 'tests'));
        if (any(testsDir, (e) => e === `test_${stem}.py`)) return true;
      } catch { /* ignore */ }
      return false;
    }

    case '.go': {
      // <stem>_test.go in same dir (Go convention)
      return any(sameDir, (e) => e === `${stem}_test.go`);
    }

    case '.rs': {
      // tests/<stem>.rs one level up (Cargo convention)
      try {
        const testsDir = listing.list(parent ? path.join(projectRoot, parent, 'tests') : path.join(projectRoot, 'tests'));
        if (any(testsDir, (e) => e === `${stem}.rs`)) return true;
      } catch { /* ignore */ }
      // sibling tests/ in same dir
      try {
        const testsDir = listing.list(path.join(projectRoot, dir, 'tests'));
        if (any(testsDir, (e) => e === `${stem}.rs`)) return true;
      } catch { /* ignore */ }
      // Inline #[cfg(test)] is intentionally not detected — would
      // require reading file content. Returning null keeps Rust files
      // out of the metric until we have a content-aware checker.
      return null;
    }

    default:
      // Convention not modeled (Java, C#, Kotlin, Ruby, C/C++).
      return null;
  }
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * filesWithoutTests(projectRoot, files) → { count, files }
 *
 * Public entry point. Pass the union blast radius — every file gets
 * checked once. Returns:
 *
 *   {
 *     count:    number,      // size of `files`
 *     files:    string[],    // relative paths with no detectable test
 *     considered: number,    // total files actually checked (excludes
 *                            // tests-themselves, non-source, ignored)
 *   }
 */
function filesWithoutTests(projectRoot, files) {
  const listing = buildListingCache();
  const without = [];
  let considered = 0;
  // Dedupe while preserving first-seen order.
  const seen = new Set();
  for (const raw of files || []) {
    const rel = typeof raw === 'string' ? raw : raw && raw.file;
    if (!rel || seen.has(rel)) continue;
    seen.add(rel);
    const has = hasTestSibling(projectRoot, rel, listing);
    if (has === null) continue;
    considered++;
    if (has === false) without.push(rel);
  }
  return { count: without.length, files: without, considered };
}

module.exports = {
  filesWithoutTests,
  // Exported for tests:
  hasTestSibling,
  isTestFile,
  isNonSourceFile,
  isIgnoredBasename,
  stemOf,
};
