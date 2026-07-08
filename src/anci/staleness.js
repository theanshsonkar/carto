'use strict';

/**
 * staleness.js — query-time index freshness (CT-1b).
 *
 * The ANCI manifest records the git commit/tree the container was built
 * from (CT-1). This module compares that recorded state against the
 * repo's current `HEAD` (and working tree) so callers can warn when the
 * index is serving numbers from an older repo state — the fix for the
 * audit's "index N commits behind HEAD with uncommitted files"
 * observation. Silently serving stale numbers breaks the "stop guessing"
 * promise.
 *
 * Everything is best-effort and read-only. When freshness can't be
 * determined (no manifest, non-git repo, git unavailable, shallow clone,
 * diverged-but-unknowable history) the status is `'unknown'` and no
 * banner is produced — "can't tell" must never masquerade as "fresh" or
 * as a false alarm.
 */

const fs = require('fs');
const path = require('path');
const yaml = require('./yaml');
const { ANCI_YAML_FILENAME } = require('./serialize');
const gitMeta = require('./git-meta');

/**
 * readManifestSource(cartoDir) → { commit, tree_hash, branch } | null
 *
 * Parses just the `source:` block out of the on-disk anci.yaml. Returns
 * null when the file is absent, unparseable, or carries no source commit.
 */
function readManifestSource(cartoDir) {
  const yamlPath = path.join(cartoDir, ANCI_YAML_FILENAME);
  let header;
  try {
    header = yaml.parse(fs.readFileSync(yamlPath, 'utf-8'));
  } catch {
    return null;
  }
  if (!header || !header.source || typeof header.source.commit !== 'string') {
    return null;
  }
  return header.source;
}

/**
 * isCartoArtifact(p) → true for Carto's own generated files. These are
 * excluded from the "dirty working tree" count — an untracked `.carto/`
 * or a regenerated `AGENTS.md` is not source drift.
 */
function isCartoArtifact(p) {
  const norm = p.replace(/\\/g, '/');
  return norm === '.carto' ||
    norm.startsWith('.carto/') ||
    norm === 'AGENTS.md' ||
    norm === '.cartoignore';
}

/**
 * computeStaleness(projectRoot, opts?) → {
 *   status: 'fresh' | 'behind' | 'diverged' | 'dirty' | 'unknown',
 *   commitsBehind: number | null,
 *   uncommitted: number | null,
 *   manifestCommit: string | null,
 *   headCommit: string | null,
 * }
 *
 * Status meanings:
 *   fresh    — manifest commit == HEAD and no uncommitted changes.
 *   dirty    — manifest commit == HEAD but the working tree has
 *              uncommitted/untracked files not reflected in the index.
 *   behind   — manifest commit is an ancestor of HEAD (index predates N
 *              commits).
 *   diverged — manifest commit is not in the current history (branch
 *              switch / rebase / amended commit).
 *   unknown  — can't determine (no manifest, non-git, git unavailable).
 */
function computeStaleness(projectRoot, opts = {}) {
  const cartoDir = opts.cartoDir || path.join(projectRoot, '.carto');
  const base = {
    status: 'unknown',
    commitsBehind: null,
    uncommitted: null,
    manifestCommit: null,
    headCommit: null,
  };

  const source = readManifestSource(cartoDir);
  if (!source || !source.commit) return base;
  base.manifestCommit = source.commit;

  if (!gitMeta.isGitRepo(projectRoot)) return base;

  const head = gitMeta.headCommit(projectRoot);
  if (!head) return base;
  base.headCommit = head;

  // Count uncommitted files, but ignore Carto's own generated artifacts
  // (.carto/, AGENTS.md, .cartoignore) — an untracked index is not source
  // drift and must not trigger a false "dirty" warning.
  const rawPaths = gitMeta.uncommittedPaths(projectRoot);
  const uncommitted = rawPaths === null
    ? null
    : rawPaths.filter((p) => !isCartoArtifact(p)).length;
  base.uncommitted = uncommitted;

  if (source.commit === head) {
    // Index matches HEAD. Only "dirty" if the working tree has changes.
    base.status = uncommitted && uncommitted > 0 ? 'dirty' : 'fresh';
    return base;
  }

  // Commits differ — is the manifest commit an ancestor of HEAD?
  const ancestor = gitMeta.isAncestor(projectRoot, source.commit, head);
  if (ancestor === true) {
    base.status = 'behind';
    base.commitsBehind = gitMeta.commitsBetween(projectRoot, source.commit, head);
  } else if (ancestor === false) {
    base.status = 'diverged';
  } else {
    // ancestor === null → couldn't determine (bad object / shallow).
    base.status = 'unknown';
  }
  return base;
}

/**
 * stalenessBanner(staleness) → string | null
 *
 * One-line, human-readable warning for a stale index, or null when the
 * index is fresh / freshness is unknown (no banner). Callers prepend
 * this to tool output and print it in `carto doctor`.
 */
function stalenessBanner(staleness) {
  if (!staleness) return null;
  const { status, commitsBehind, uncommitted } = staleness;
  const dirtyTail = uncommitted && uncommitted > 0
    ? ` (${uncommitted} uncommitted file${uncommitted === 1 ? '' : 's'} also not indexed)`
    : '';

  switch (status) {
    case 'behind': {
      const n = typeof commitsBehind === 'number' ? commitsBehind : null;
      const count = n === null ? 'several' : `${n}`;
      const noun = n === 1 ? 'commit' : 'commits';
      return `⚠️ Carto graph is ${count} ${noun} behind HEAD — results may be inaccurate. ` +
        `Run \`carto sync\` to refresh.${dirtyTail}`;
    }
    case 'diverged':
      return `⚠️ Carto graph was built from a commit not in the current history ` +
        `(branch switch / rebase) — results may be inaccurate. Run \`carto sync\`.${dirtyTail}`;
    case 'dirty':
      return `⚠️ ${uncommitted} uncommitted file${uncommitted === 1 ? '' : 's'} since the ` +
        `graph was built — results may be inaccurate. Run \`carto sync\` to refresh.`;
    default:
      return null; // fresh | unknown → no banner
  }
}

module.exports = { computeStaleness, stalenessBanner, readManifestSource };
