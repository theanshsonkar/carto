'use strict';

/**
 * Minimal unified-diff parser.
 *
 * Zero deps, zero allocations beyond the result rows. Handles the subset
 * of unified diff that GitHub PRs, `git diff`, and `git format-patch`
 * actually emit:
 *
 *   - Per-file headers: `--- a/path`  /  `+++ b/path`
 *   - File-mode markers: `new file mode`, `deleted file mode`, `rename from`,
 *     `rename to`. We surface `kind` ∈ { 'modify' | 'add' | 'delete' | 'rename' }.
 *   - Hunk headers: `@@ -from,len +to,len @@ optional context`
 *   - Body lines: `+added`, `-removed`, ` context`, `\\ No newline at EOF`
 *   - `Binary files ... differ` lines — we skip the whole file.
 *
 * Out of scope:
 *   - Combined diffs (`@@@ ... @@@`) — git rarely emits these except for
 *     octopus merges. We tolerate (skip) the file.
 *   - SVN / Mercurial extension lines.
 *
 * Output shape — one entry per file:
 *   {
 *     path: string,                      // post-image path (`+++ b/...`)
 *     oldPath: string | null,            // pre-image path (different on rename)
 *     kind: 'modify' | 'add' | 'delete' | 'rename',
 *     added: [{lineNo, content}],        // line numbers in the new file
 *     removed: [{lineNo, content}],      // line numbers in the old file
 *   }
 *
 * Malformed input must never throw — return whatever we parsed.
 */

function stripDiffPath(raw) {
  if (!raw || typeof raw !== 'string') return null;
  // Strip trailing tab/timestamp markers that some unified diffs append.
  let p = raw.split('\t')[0].trim();
  // Drop git's a/ or b/ prefix if present.
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  // /dev/null sentinel for new/deleted files.
  if (p === '/dev/null') return null;
  return p;
}

/**
 * parseDiff(diffText) → [{ path, oldPath, kind, added, removed }]
 *
 * Top-level entry. Defensive against truncation, malformed hunks, or
 * input that isn't a diff at all (returns []).
 */
function parseDiff(diffText) {
  if (typeof diffText !== 'string' || diffText.length === 0) return [];
  const lines = diffText.split(/\r?\n/);
  const files = [];
  let cur = null;
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  // `pendingMode` tracks file-mode hints between the `diff --git` header
  // and the `---/+++` lines that finalize the entry.
  let pendingKind = null;
  let pendingOldPath = null;
  let pendingNewPath = null;

  function flush() {
    // Materialise rename-only entries that never produced a `+++ ` line.
    if (!cur && pendingKind === 'rename' && pendingOldPath && pendingNewPath) {
      cur = {
        path: pendingNewPath,
        oldPath: pendingOldPath !== pendingNewPath ? pendingOldPath : null,
        kind: 'rename',
        added: [],
        removed: [],
      };
    }
    if (cur) files.push(cur);
    cur = null;
    inHunk = false;
    pendingKind = null;
    pendingOldPath = null;
    pendingNewPath = null;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // `diff --git a/foo b/bar` — start of a new file entry. Pre-resolve
    // the rename paths from the header so we have them even if the
    // rename has zero hunks.
    if (line.startsWith('diff --git ')) {
      flush();
      pendingKind = 'modify';
      pendingOldPath = null;
      pendingNewPath = null;
      const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      if (m) {
        pendingOldPath = m[1];
        pendingNewPath = m[2];
      }
      continue;
    }

    if (line.startsWith('new file mode')) { pendingKind = 'add'; continue; }
    if (line.startsWith('deleted file mode')) { pendingKind = 'delete'; continue; }
    if (line.startsWith('rename from ')) {
      pendingKind = 'rename';
      pendingOldPath = line.slice('rename from '.length).trim();
      continue;
    }
    if (line.startsWith('rename to ')) {
      pendingKind = 'rename';
      pendingNewPath = line.slice('rename to '.length).trim();
      continue;
    }

    // Skip binary diffs — we can't validate them anyway.
    if (line.startsWith('Binary files ') && line.endsWith(' differ')) {
      flush();
      continue;
    }

    if (line.startsWith('--- ')) {
      const oldP = stripDiffPath(line.slice(4));
      if (oldP !== null) pendingOldPath = oldP;
      continue;
    }

    if (line.startsWith('+++ ')) {
      // Finalize the file header. Open a new `cur` entry.
      const newP = stripDiffPath(line.slice(4));
      if (newP !== null) pendingNewPath = newP;
      const path = pendingNewPath || pendingOldPath;
      if (!path) continue;
      cur = {
        path,
        oldPath: pendingOldPath !== pendingNewPath ? pendingOldPath : null,
        kind: pendingKind || 'modify',
        added: [],
        removed: [],
      };
      // /dev/null on the old side means add; on the new side means delete.
      if (cur.kind === 'modify') {
        if (pendingOldPath === null && pendingNewPath !== null) cur.kind = 'add';
        else if (pendingNewPath === null && pendingOldPath !== null) cur.kind = 'delete';
      }
      pendingKind = null;
      pendingOldPath = null;
      pendingNewPath = null;
      inHunk = false;
      continue;
    }

    if (!cur) continue;

    // Hunk header: @@ -oldStart,oldLen +newStart,newLen @@ (lengths optional)
    if (line.startsWith('@@')) {
      const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) {
        oldLine = parseInt(m[1], 10);
        newLine = parseInt(m[2], 10);
        inHunk = true;
      } else {
        inHunk = false;
      }
      continue;
    }

    if (!inHunk) continue;

    // Body lines.
    if (line.length === 0) {
      // A blank body line is "context" with empty content. Both old and
      // new advance.
      oldLine++;
      newLine++;
      continue;
    }
    const tag = line[0];
    const content = line.slice(1);
    if (tag === '+') {
      cur.added.push({ lineNo: newLine, content });
      newLine++;
    } else if (tag === '-') {
      cur.removed.push({ lineNo: oldLine, content });
      oldLine++;
    } else if (tag === ' ') {
      oldLine++;
      newLine++;
    } else if (tag === '\\') {
      // "\ No newline at end of file" — no line advance.
      continue;
    } else {
      // Unknown body line — be tolerant and stop hunk parsing.
      inHunk = false;
    }
  }

  flush();
  return files;
}

/**
 * extractAddedImports(file) → string[]
 *
 * Heuristic: scan added lines for import-style statements common across
 * JS/TS, Python, Go, Rust, Ruby, Java. Returns the bare module / path
 * specifier (the thing inside the quotes / after `from`/`import`/`use`).
 *
 * Used by validate.js to detect new cross-domain edges. Exported for
 * test coverage. Best-effort — we'd rather miss than spuriously flag.
 */
function extractAddedImports(file) {
  if (!file || !Array.isArray(file.added)) return [];
  const out = [];
  for (const { content } of file.added) {
    if (!content) continue;
    const trimmed = content.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('#')) continue;
    // ES module: import X from 'mod' / import 'mod' / import { x } from "mod"
    let m = trimmed.match(/^import\s+(?:[^'"]*?from\s+)?['"]([^'"]+)['"]/);
    if (m) { out.push(m[1]); continue; }
    // CommonJS: const x = require('mod')
    m = trimmed.match(/require\(\s*['"]([^'"]+)['"]\s*\)/);
    if (m) { out.push(m[1]); continue; }
    // Dynamic import: import('mod')
    m = trimmed.match(/^import\(\s*['"]([^'"]+)['"]\s*\)/);
    if (m) { out.push(m[1]); continue; }
    // Python: from mod import x  /  import mod
    m = trimmed.match(/^from\s+([\w.]+)\s+import\b/);
    if (m) { out.push(m[1]); continue; }
    m = trimmed.match(/^import\s+([\w.]+)\s*$/);
    if (m) { out.push(m[1]); continue; }
    // Go: import "mod"  /  multi-line import block
    m = trimmed.match(/^import\s+['"]([^'"]+)['"]/);
    if (m) { out.push(m[1]); continue; }
    // Rust: use crate::a::b::c;
    m = trimmed.match(/^use\s+([\w:]+)/);
    if (m) { out.push(m[1]); continue; }
    // Java: import a.b.C;
    m = trimmed.match(/^import\s+([\w.]+);/);
    if (m) { out.push(m[1]); continue; }
  }
  return out;
}

module.exports = { parseDiff, extractAddedImports, stripDiffPath };
