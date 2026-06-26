'use strict';

/**
 * load-verified.js — SWE-bench-Verified JSONL ingestion.
 *
 * SWE-bench-Verified is a 500-problem benchmark from Princeton NLP,
 * distributed as JSONL on Hugging Face:
 *   https://huggingface.co/datasets/princeton-nlp/SWE-bench_Verified
 *
 * Download once:
 *
 *   huggingface-cli download princeton-nlp/SWE-bench_Verified \
 *     --repo-type dataset --local-dir ~/swe-bench-verified
 *
 * The path lookup order:
 *   1. CARTO_SWE_VERIFIED_PATH env var (explicit override)
 *   2. ~/swe-bench-verified/data/test.jsonl  (HF download default)
 *   3. ~/swe-bench-verified/test.jsonl       (flat layout)
 *   4. ./bench/swe-bench/data/verified.jsonl (committed dev fixture, optional)
 *
 * Each JSONL row has the upstream SWE-bench-Verified schema:
 *
 *   {
 *     "instance_id":       "django__django-11099",
 *     "repo":              "django/django",
 *     "base_commit":       "<sha>",
 *     "problem_statement": "<issue body>",
 *     "hints_text":        "<comments>",
 *     "patch":             "<gold-standard diff>",
 *     "test_patch":        "<diff to test file>",
 *     "FAIL_TO_PASS":      "[\"test.path::name\", ...]",   // stringified
 *     "PASS_TO_PASS":      "[\"test.path::name\", ...]",   // stringified
 *     "created_at":        "...",
 *     "version":           "..."
 *   }
 *
 * This loader normalizes that into the task shape the harness expects:
 *
 *   {
 *     id, kind: 'multi_file', description,
 *     repo,                       // upstream repo for cloning
 *     baseCommit,                 // SHA at which the issue exists
 *     problemStatement,           // what the agent sees
 *     hints,                      // optional extra context
 *     verifier: {                 // tells score.js to use test-runner mode
 *       kind: 'swebench',
 *       goldPatch, testPatch,
 *       failToPass: string[],
 *       passToPass: string[],
 *     },
 *     // No `repo` (filesystem tree) or `expected`/stubControl/stubCarto
 *     // fields — those are mini-suite-only. The verified runner reads
 *     // the actual upstream repo at the base commit instead.
 *   }
 *
 * Kind classification: we mark every Verified task as `multi_file`
 * because that's where Carto's wedge is strongest. A future
 * refinement could parse `patch` to count touched files and split
 * into single/multi/architectural buckets — for v0 we keep it simple.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

function resolveDatasetPath() {
  const candidates = [
    process.env.CARTO_SWE_VERIFIED_PATH,
    path.join(os.homedir(), 'swe-bench-verified', 'data', 'test.jsonl'),
    path.join(os.homedir(), 'swe-bench-verified', 'test.jsonl'),
    path.join(__dirname, 'data', 'verified.jsonl'),
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function parseJsonField(s, fallback) {
  if (typeof s !== 'string') return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
}

/**
 * loadVerified(opts?) → Task[]
 *
 *   opts.path  — override the resolved dataset path
 *   opts.limit — max tasks (useful for dev / smoke runs)
 *
 * Throws with a clear, copy-pasteable HF download instruction when the
 * dataset isn't reachable. We don't fetch the dataset ourselves —
 * 200 MB of issue text is a network-policy decision the operator
 * makes once, not on every harness invocation.
 */
function loadVerified(opts = {}) {
  const datasetPath = opts.path || resolveDatasetPath();
  if (!datasetPath) {
    throw new Error(
      'SWE-bench-Verified dataset not found. Download once with:\n\n' +
      '  pip install huggingface_hub\n' +
      '  huggingface-cli download princeton-nlp/SWE-bench_Verified \\\n' +
      '    --repo-type dataset --local-dir ~/swe-bench-verified\n\n' +
      'Or set CARTO_SWE_VERIFIED_PATH to a local JSONL path.',
    );
  }

  const text = fs.readFileSync(datasetPath, 'utf8');
  const tasks = [];
  for (const line of text.split('\n')) {
    const trim = line.trim();
    if (!trim) continue;
    let row;
    try { row = JSON.parse(trim); }
    catch { continue; }  // tolerate trailing junk
    if (!row.instance_id || !row.repo || !row.base_commit) continue;

    tasks.push({
      id: row.instance_id,
      kind: 'multi_file',
      description: row.problem_statement || '',
      // SWE-bench tasks reference real upstream repos at specific SHAs.
      // The harness clones into a scratch dir at base_commit; there's
      // no synthetic `repo` filesystem-tree to materialize.
      upstream: {
        repo: row.repo,
        baseCommit: row.base_commit,
      },
      problemStatement: row.problem_statement || '',
      hints: row.hints_text || '',
      verifier: {
        kind: 'swebench',
        goldPatch: row.patch || '',
        testPatch: row.test_patch || '',
        failToPass: parseJsonField(row.FAIL_TO_PASS, []),
        passToPass: parseJsonField(row.PASS_TO_PASS, []),
      },
      // No `expected` / stub diffs — verified runs use the test runner
      // for scoring, not diff-comparison.
    });
    if (opts.limit && tasks.length >= opts.limit) break;
  }
  if (tasks.length === 0) {
    throw new Error(
      `SWE-bench-Verified dataset at ${datasetPath} is empty or unparseable.`,
    );
  }
  return tasks;
}

module.exports = { loadVerified, resolveDatasetPath };
