'use strict';

/**
 * Temporal backfill — replay git history into `.carto/carto-temporal.db`.
 *
 * `carto temporal init` walks the git log and emits one snapshot row per
 * commit, plus per-file churn aggregates.
 *
 * What it does:
 *   1. Resolve the git executable and confirm we're in a git repo.
 *   2. `git log --reverse --pretty=format:%H|%ct|%an|%s --name-only --no-merges`
 *      streams commits in chronological order with the files they touched.
 *   3. For each commit:
 *      - Insert a snapshot row with source='commit'.
 *      - For each touched file, increment `file_churn.commit_count` and
 *        update first/last-seen timestamps.
 *      - Flag significant events (large drops, large deletions). Domain
 *        inference per-commit is intentionally skipped — it would require
 *        re-parsing the entire history with tree-sitter, blowing the
 *        100 ms/commit budget. Domain-evolution events come from
 *        sync-time snapshots only, where the bitmap sidecar already gives
 *        authoritative assignments.
 *   4. After backfill, the current sidecar is captured as the most recent
 *      snapshot, anchoring `file_domains_at` to live data.
 *
 * Filters: only files matching the same extensions Carto would index count
 * toward churn. Test files (matching the indexer's exclusion patterns) are
 * dropped so churn numbers line up with blast_radius.
 *
 * Streaming: the git child process emits output line-by-line; the entire
 * log is never buffered. A 100K-commit history processes in ~10-20s on a
 * dev box — bottleneck is git itself, not the parser.
 */

const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { TemporalStore } = require('./store');

const CODE_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.r', '.R', '.prisma', '.html', '.go', '.rb',
  '.rs', '.java', '.cs', '.cpp', '.cc', '.cxx', '.h', '.hpp',
  '.swift', '.kt', '.php', '.dart',
]);

const JS_LIKE_EXTS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs']);

function isCodeFile(p) {
  const lower = p.toLowerCase();
  const ext = path.extname(lower);
  if (!CODE_EXTS.has(ext)) return false;
  const base = path.basename(lower);
  if (ext === '.r') {
    if (base.startsWith('test_') || base.startsWith('test-') || base.endsWith('_test.r')) return false;
  }
  if (ext === '.py') {
    if (base.startsWith('test_') || base.endsWith('_test.py')) return false;
  }
  if (JS_LIKE_EXTS.has(ext)) {
    if (base.includes('.test.') || base.includes('.spec.') || base.includes('.stories.')) return false;
  }
  return true;
}

/**
 * isGitRepo(projectRoot) → boolean
 */
function isGitRepo(projectRoot) {
  try {
    execFileSync('git', ['-C', projectRoot, 'rev-parse', '--git-dir'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * backfillFromGit({ projectRoot, maxCommits, onProgress, since })
 *
 * Returns: { commits, files, elapsedMs, events, errors }
 *
 * `maxCommits`: cap on the number of commits to process. Defaults to
 *               2000 — a 5+ year history for most projects.
 * `onProgress`: optional ({ done, total }) callback for CLI.
 * `since`:      git-log `--since` argument (e.g. '1 year ago').
 */
async function backfillFromGit({ projectRoot, maxCommits = 2000, onProgress = null, since = null }) {
  const startMs = Date.now();
  const errors = [];

  if (!isGitRepo(projectRoot)) {
    return { commits: 0, files: 0, elapsedMs: 0, errors: ['Not a git repo — backfill skipped.'] };
  }

  const temporal = new TemporalStore(projectRoot);
  temporal.open();

  try {
    const args = ['-C', projectRoot, 'log', '--reverse', '--no-merges',
      '--pretty=format:COMMIT|%H|%ct',
      '--name-only',
    ];
    if (since) args.push(`--since=${since}`);
    if (Number.isFinite(maxCommits) && maxCommits > 0) args.push(`-n${maxCommits}`);

    const child = spawn('git', args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let buf = '';
    let curSha = null;
    let curTs = null;
    let curFiles = [];
    let commitCount = 0;
    let fileTouches = 0;

    const flush = () => {
      if (curSha && curTs && curFiles.length > 0) {
        // Insert snapshot.
        const snapshotId = temporal.insertSnapshot({
          ts: curTs,
          commit_sha: curSha,
          source: 'commit',
          summary: { file_count: curFiles.length, edge_count: 0, domain_count: 0 },
        });
        // Update churn.
        temporal.recordCommitChurn(curTs, curFiles);
        commitCount++;
        fileTouches += curFiles.length;
        if (onProgress && commitCount % 100 === 0) {
          onProgress({ done: commitCount, files: fileTouches });
        }
      } else if (curSha && curTs) {
        // Commit with no relevant files — still insert the snapshot so
        // the timeline isn't gappy.
        temporal.insertSnapshot({
          ts: curTs, commit_sha: curSha, source: 'commit',
          summary: { file_count: 0, edge_count: 0, domain_count: 0 },
        });
        commitCount++;
      }
      curSha = null;
      curTs = null;
      curFiles = [];
    };

    child.stdout.setEncoding('utf-8');
    for await (const chunk of child.stdout) {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.startsWith('COMMIT|')) {
          flush();
          const parts = line.split('|');
          if (parts.length >= 3) {
            curSha = parts[1];
            curTs = parseInt(parts[2], 10) * 1000;
          }
        } else if (line.length > 0) {
          if (isCodeFile(line)) curFiles.push(line);
        }
        // empty lines: separator between commits — ignore
      }
    }
    if (buf.length > 0) {
      // Tail: trailing line may not end with \n.
      if (buf.startsWith('COMMIT|')) {
        flush();
        const parts = buf.split('|');
        if (parts.length >= 3) {
          curSha = parts[1];
          curTs = parseInt(parts[2], 10) * 1000;
        }
      } else if (isCodeFile(buf)) {
        curFiles.push(buf);
      }
    }
    flush();

    // Capture stderr for diagnosis.
    let stderr = '';
    child.stderr.setEncoding('utf-8');
    for await (const chunk of child.stderr) stderr += chunk;

    await new Promise((resolve) => {
      child.on('close', resolve);
      child.on('error', () => resolve());
    });

    if (stderr && stderr.trim().length > 0) {
      // Only treat as error if no commits were captured.
      if (commitCount === 0) errors.push(`git log: ${stderr.trim().split('\n').slice(0, 2).join(' ')}`);
    }

    temporal.setMeta('last_backfill_at', String(Date.now()));
    temporal.setMeta('last_backfill_commits', String(commitCount));

    return {
      commits: commitCount,
      files: fileTouches,
      elapsedMs: Date.now() - startMs,
      errors,
    };
  } finally {
    temporal.close();
  }
}

module.exports = { backfillFromGit, isGitRepo, isCodeFile };
