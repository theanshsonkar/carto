'use strict';

/**
 * git-meta.js — read-only git identity helpers for ANCI container
 * identity (CT-1) and query-time staleness (CT-1b).
 *
 * Every function is best-effort: on a non-git directory, a missing git
 * executable, a shallow clone, or any git failure, it returns `null`
 * rather than throwing. Callers treat `null` as "unknown" and degrade
 * gracefully — identity fields become `null` in the manifest, and the
 * staleness check stays silent when it can't tell.
 *
 * All calls are `git -C <root> …` via `execFileSync` (no shell — the
 * repo path is passed as an argv element, never interpolated into a
 * command string), mirroring the access pattern already used by
 * `src/temporal/backfill.js`.
 */

const { execFileSync } = require('child_process');

/**
 * git(root, args) → trimmed stdout string, or null on any failure.
 */
function git(root, args) {
  try {
    const out = execFileSync('git', ['-C', root, ...args], {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf-8',
      maxBuffer: 8 * 1024 * 1024,
    });
    return typeof out === 'string' ? out.trim() : null;
  } catch {
    return null;
  }
}

/**
 * isGitRepo(root) → boolean
 */
function isGitRepo(root) {
  return git(root, ['rev-parse', '--git-dir']) !== null;
}

/**
 * headCommit(root) → full 40-char SHA of HEAD, or null.
 */
function headCommit(root) {
  const sha = git(root, ['rev-parse', 'HEAD']);
  return sha && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

/**
 * headTree(root) → tree hash of HEAD (`HEAD^{tree}`), or null.
 *
 * The tree hash identifies the exact committed file content, so two
 * builds of the same tree share a tree_hash even across cherry-picks.
 */
function headTree(root) {
  const sha = git(root, ['rev-parse', 'HEAD^{tree}']);
  return sha && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

/**
 * currentBranch(root) → branch name, or null (also null in detached HEAD,
 * where git prints "HEAD").
 */
function currentBranch(root) {
  const name = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!name || name === 'HEAD') return null;
  return name;
}

/**
 * commitsBetween(root, from, to) → integer count of commits in `from..to`
 * (i.e. reachable from `to` but not `from`), or null if it can't be
 * computed (unknown commit, diverged history where `from` isn't an
 * ancestor, shallow clone, etc.).
 */
function commitsBetween(root, from, to = 'HEAD') {
  if (!from) return null;
  const out = git(root, ['rev-list', '--count', `${from}..${to}`]);
  if (out === null) return null;
  const n = parseInt(out, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * isAncestor(root, maybeAncestor, descendant) → boolean | null
 *
 * True iff `maybeAncestor` is an ancestor of `descendant`. Null when it
 * can't be determined. Uses `git merge-base --is-ancestor` (exit 0 =
 * yes, exit 1 = no).
 */
function isAncestor(root, maybeAncestor, descendant = 'HEAD') {
  if (!maybeAncestor) return null;
  try {
    execFileSync('git', ['-C', root, 'merge-base', '--is-ancestor', maybeAncestor, descendant], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch (err) {
    // Exit code 1 = definitively not an ancestor; other codes = unknown
    // (bad object, not a repo). Distinguish so callers can tell "behind"
    // from "diverged / unknown".
    if (err && err.status === 1) return false;
    return null;
  }
}

/**
 * uncommittedPaths(root) → string[] of repo-relative paths with
 * uncommitted changes (staged, unstaged, or untracked), or null on
 * failure. Handles porcelain rename records (`R old -> new`).
 */
function uncommittedPaths(root) {
  const out = git(root, ['status', '--porcelain']);
  if (out === null) return null;
  if (out === '') return [];
  const paths = [];
  for (const line of out.split('\n')) {
    if (line.length < 4) continue;
    // Porcelain v1: "XY <path>" (path from col 3); renames as "old -> new".
    let p = line.slice(3);
    const arrow = p.indexOf(' -> ');
    if (arrow >= 0) p = p.slice(arrow + 4);
    // Strip optional surrounding quotes git adds for paths with spaces.
    p = p.trim();
    if (p.length >= 2 && p[0] === '"' && p[p.length - 1] === '"') p = p.slice(1, -1);
    if (p) paths.push(p);
  }
  return paths;
}

/**
 * uncommittedCount(root) → number of files with uncommitted changes
 * (staged, unstaged, or untracked), or null on failure.
 */
function uncommittedCount(root) {
  const paths = uncommittedPaths(root);
  return paths === null ? null : paths.length;
}

/**
 * sourceIdentity(root) → { commit, tree_hash, branch }
 *
 * The manifest `source:` block. Every field is a string or null. Safe on
 * a non-git repo (all null).
 */
function sourceIdentity(root) {
  if (!isGitRepo(root)) {
    return { commit: null, tree_hash: null, branch: null };
  }
  return {
    commit: headCommit(root),
    tree_hash: headTree(root),
    branch: currentBranch(root),
  };
}

module.exports = {
  git,
  isGitRepo,
  headCommit,
  headTree,
  currentBranch,
  commitsBetween,
  isAncestor,
  uncommittedPaths,
  uncommittedCount,
  sourceIdentity,
};
