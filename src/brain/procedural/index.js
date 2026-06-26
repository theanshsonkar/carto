'use strict';

/**
 * Procedural Memory — action patterns mined from commit history.
 *
 * Mines "when developers add X, they also touch Y" from the git log.
 * Output is a list of procedural patterns the AI can use when scaffolding
 * a common change:
 *
 *   "When adding a route, you also need to:
 *      1. create src/routes/*.handler.ts
 *      2. update src/routes/index.ts
 *      3. add a model in src/models/*.ts"
 *
 * Simple co-occurrence: for each pair of files (a, b), count how often they
 * appear in the same commit. Pairs co-occurring in >= 0.6 of a's commits
 * become procedural patterns.
 *
 * The temporal store keeps aggregate churn rather than per-commit
 * membership, so the detector shells out to `git log` for the last 200
 * commits and counts pair occurrences in memory. Cheaper than a per-commit
 * membership table and good enough for the scaffolding use-case.
 */

const DEFAULT_THRESHOLD = 0.6;
const MIN_COMMITS = 3;

/**
 * mineActionPatterns(temporalStore, opts) → Array<pattern>
 *
 * Pattern shape:
 *   { id, kind, anchor, partners: [{ file, co_occurrence }], confidence, evidence_count }
 */
function mineActionPatterns(temporalStore, { threshold = DEFAULT_THRESHOLD } = {}) {
  if (!temporalStore || !temporalStore.db) return [];

  // The temporal store keeps aggregate churn rather than (snapshot_id,
  // file_path) membership, so we can't reconstruct per-commit file sets
  // from it directly. Shelling out to `git log` for the last 200 commits
  // is cheaper than carrying a membership table and stays deterministic.
  // A membership table would let us mine patterns over the full history;
  // worth doing once an actual use-case for older commits shows up.
  // Bail early if there are no backfilled commits — nothing to mine.
  const commitTimestamps = temporalStore.db.prepare(`
    SELECT DISTINCT ts FROM snapshots WHERE source = 'commit' ORDER BY ts ASC
  `).all();
  if (commitTimestamps.length === 0) return [];

  const { execFileSync } = require('child_process');
  let log;
  try {
    log = execFileSync('git', [
      '-C', temporalStore._projectRoot,
      'log', '--no-merges', '-n', '200',
      '--pretty=format:COMMIT|%H|%ct', '--name-only',
    ], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32 * 1024 * 1024 });
  } catch {
    return [];
  }

  const commits = [];
  let cur = null;
  for (const line of log.split('\n')) {
    if (line.startsWith('COMMIT|')) {
      if (cur && cur.files.length > 0) commits.push(cur);
      cur = { files: [] };
    } else if (line.length > 0 && cur) {
      cur.files.push(line);
    }
  }
  if (cur && cur.files.length > 0) commits.push(cur);

  if (commits.length < MIN_COMMITS) return [];

  // Co-occurrence: per-file, count how many commits include it; per-pair,
  // count how many commits include both.
  const fileCount = new Map();
  const pairCount = new Map();
  for (const c of commits) {
    const seen = new Set();
    for (const f of c.files) seen.add(f);
    for (const f of seen) fileCount.set(f, (fileCount.get(f) || 0) + 1);
    const arr = Array.from(seen).sort();
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const key = `${arr[i]}|${arr[j]}`;
        pairCount.set(key, (pairCount.get(key) || 0) + 1);
      }
    }
  }

  // For each file with >=3 commits, list its strong partners.
  const out = [];
  for (const [anchor, count] of fileCount) {
    if (count < MIN_COMMITS) continue;
    const partners = [];
    for (const [pair, pCount] of pairCount) {
      const [a, b] = pair.split('|');
      if (a !== anchor && b !== anchor) continue;
      const other = a === anchor ? b : a;
      const conf = pCount / count;
      if (conf >= threshold) partners.push({ file: other, co_occurrence: Math.round(conf * 100) / 100, commits: pCount });
    }
    partners.sort((x, y) => y.co_occurrence - x.co_occurrence);
    if (partners.length > 0) {
      out.push({
        id: `pattern_${anchor.replace(/[^a-z0-9]/gi, '_')}`,
        kind: 'co_change',
        anchor,
        partners: partners.slice(0, 10),
        confidence: partners[0].co_occurrence,
        evidence_count: count,
      });
    }
  }

  out.sort((a, b) => b.evidence_count - a.evidence_count);
  return out.slice(0, 50);
}

/**
 * actionPatternsForIntent(temporalStore, store, intent, opts) → Array<pattern>
 *
 * Finds patterns whose anchor file is relevant to the natural-language
 * intent. Reuses the change-plan tokenizer for ranking.
 */
function actionPatternsForIntent(temporalStore, store, intent, opts = {}) {
  const all = mineActionPatterns(temporalStore, opts);
  if (!intent || all.length === 0) return all.slice(0, 5);

  const tokens = String(intent).toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 3);
  const scored = all.map(p => {
    const text = (p.anchor + ' ' + p.partners.map(x => x.file).join(' ')).toLowerCase();
    let score = 0;
    for (const t of tokens) {
      if (text.includes(t)) score += 1;
    }
    return { ...p, _score: score };
  });
  scored.sort((a, b) => (b._score - a._score) || (b.evidence_count - a.evidence_count));
  return scored.filter(p => p._score > 0).slice(0, 5);
}

/**
 * scaffoldForIntent(temporalStore, store, intent) → { intent, suggestions, conventions }
 */
function scaffoldForIntent(temporalStore, store, intent) {
  const patterns = actionPatternsForIntent(temporalStore, store, intent);
  const conventions = require('../conventions');
  const invariants = require('../invariants');

  const suggestions = [];
  for (const p of patterns) {
    suggestions.push({
      anchor_file: p.anchor,
      co_changed_files: p.partners.slice(0, 5).map(x => x.file),
      confidence: p.confidence,
      evidence: `${p.evidence_count} historical commits`,
    });
  }

  // Pull canonical patterns for likely scaffold types.
  const lower = String(intent || '').toLowerCase();
  const canonical = [];
  if (lower.includes('route') || lower.includes('endpoint') || lower.includes('api')) {
    const r = invariants.getCanonicalPattern(store, { pattern_type: 'route_handler' });
    if (r) canonical.push(r);
  }
  if (lower.includes('model') || lower.includes('schema') || lower.includes('entity')) {
    const m = invariants.getCanonicalPattern(store, { pattern_type: 'model_definition' });
    if (m) canonical.push(m);
  }

  return {
    intent,
    suggestions,
    canonical,
  };
}

module.exports = { mineActionPatterns, actionPatternsForIntent, scaffoldForIntent, DEFAULT_THRESHOLD };
