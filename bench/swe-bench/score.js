'use strict';

/**
 * score.js — grade a candidate diff against a task's expected outcome.
 *
 * Scoring rubric:
 *
 *   - PASS    if the candidate diff:
 *               (a) modifies every file in `expected.requiredFiles`,
 *               (b) introduces every line in `expected.addedLines`,
 *               (c) removes every line in `expected.removedLines`.
 *
 *   - PARTIAL if the candidate touches >0 required files AND
 *               introduces ≥50% of the required added lines.
 *               (Captures the realistic case where Claude-alone gets
 *               *some* of the rename right but misses others.)
 *
 *   - FAIL    otherwise.
 *
 * Plus a numeric `coverage` ∈ [0, 1] for the bootstrap CI math —
 * fraction of expected added lines actually present.
 *
 * Scoring is intentionally heuristic, not AST-aware. SWE-bench-Verified
 * itself uses test execution as its oracle, not diff comparison. For the
 * sample task-set we don't have unit tests; the expected-lines check is
 * the substitute. A real-Verified run replaces this scorer with a test
 * runner that executes `pytest` (or equivalent) in the repo state.
 */

const { parseDiff } = require('../../src/mcp/diff-parser');

/**
 * scoreDiff(diffText, expected) → {
 *   outcome: 'PASS' | 'PARTIAL' | 'FAIL',
 *   coverage: number,            // 0..1
 *   filesTouched: string[],
 *   filesRequired: string[],
 *   missingFiles: string[],
 *   missingAdded: string[],
 *   missingRemoved: string[],
 * }
 *
 * `expected` shape: { addedLines:Set<string>, removedLines:Set<string>,
 *                     requiredFiles:Set<string> }
 */
function scoreDiff(diffText, expected) {
  const parsed = parseDiff(diffText) || [];
  const filesTouched = parsed.map((f) => f.path);

  // Aggregate every added + removed line across every file in the diff.
  // diff-parser emits added/removed as [{lineNo, content}, ...] — we
  // only need the content. We strip leading whitespace before
  // comparing — the agent might indent differently than the canonical
  // solution. Comparison is exact-modulo-leading-whitespace.
  const addedSet = new Set();
  const removedSet = new Set();
  for (const f of parsed) {
    for (const item of f.added || []) {
      const s = typeof item === 'string' ? item : (item && item.content) || '';
      addedSet.add(s.replace(/^\s+/, '').trim());
    }
    for (const item of f.removed || []) {
      const s = typeof item === 'string' ? item : (item && item.content) || '';
      removedSet.add(s.replace(/^\s+/, '').trim());
    }
  }

  const norm = (s) => s.replace(/^\s+/, '').trim();
  const requiredAdded = [...expected.addedLines].map(norm);
  const requiredRemoved = [...expected.removedLines].map(norm);
  const requiredFiles = [...expected.requiredFiles];

  const missingFiles = requiredFiles.filter((p) => !filesTouched.includes(p));
  const missingAdded = requiredAdded.filter((l) => !addedSet.has(l));
  const missingRemoved = requiredRemoved.filter((l) => !removedSet.has(l));

  const coverage =
    requiredAdded.length === 0
      ? (missingFiles.length === 0 ? 1 : 0)
      : (requiredAdded.length - missingAdded.length) / requiredAdded.length;

  let outcome;
  if (missingFiles.length === 0 && missingAdded.length === 0 && missingRemoved.length === 0) {
    outcome = 'PASS';
  } else if (filesTouched.length > 0 && coverage >= 0.5) {
    outcome = 'PARTIAL';
  } else {
    outcome = 'FAIL';
  }

  return {
    outcome,
    coverage: Number(coverage.toFixed(4)),
    filesTouched,
    filesRequired: requiredFiles,
    missingFiles,
    missingAdded,
    missingRemoved,
  };
}

/**
 * groupByKind(results, tasks) → { single_file: results[], multi_file: results[], architectural: results[] }
 *
 * Used by the aggregator to compute the multi-file split. Stable
 * sentinel order so the report's rows always line up.
 */
function groupByKind(results, tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const out = { single_file: [], multi_file: [], architectural: [] };
  for (const r of results) {
    const t = byId.get(r.taskId);
    const kind = t ? t.kind : 'single_file';
    (out[kind] || out.single_file).push(r);
  }
  return out;
}

module.exports = { scoreDiff, groupByKind };
