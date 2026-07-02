'use strict';

/**
 * Rule engine — gap detection.
 *
 * A gap is a claim, grounded in a Carto fact, that the code violates
 * a rule. The engine iterates a rule library, gates each rule by the
 * project's stated intent (product_type), and collects the grounded
 * findings.
 *
 * Contract for every rule module:
 *
 *   module.exports = {
 *     id: 'money-as-float',              // stable across releases
 *     severity: 'HIGH' | 'MEDIUM' | 'LOW',
 *     reversibility: 'easy' | 'moderate' | 'hard',
 *     concept: 'money-as-float',         // basename of concept file
 *     description: 'One-line human summary',
 *
 *     appliesWhen(intent) → boolean,     // gate — false = skip entirely
 *     run({ store, sidecar, intent }) → Gap[]  // grounded findings
 *   }
 *
 * Every returned Gap must include `{ rule_id, file, evidence }` at a
 * minimum. `line` is optional but strongly encouraged (falsifiability
 * gets sharper the more specific the citation).
 *
 * Determinism: rules must not use random numbers, Date.now (except
 * through the engine), or hit the network. Same store + same intent →
 * identical Gap[]. The engine dedups by `gap_hash` (sha1 of rule_id +
 * file + line) before returning.
 */

const crypto = require('crypto');
const { loadIntent } = require('./intent');
const rules = require('./registry');

/**
 * runEngine({ store, sidecar, projectRoot, intent? }) → RunResult
 *
 * Runs every registered rule against the current store, gated by the
 * loaded intent. Returns:
 *
 *   {
 *     gaps: Gap[],                     // deduped, ranked, hashed
 *     ranBy: [{ rule_id, count, ms, applied }],
 *     skipped: [{ rule_id, reason }],
 *     intent: { product_type, ... },
 *     ranAt: <unix ms>,
 *   }
 *
 * If `intent` is not passed, it's loaded from `.carto/intent.json`.
 * If no intent file exists, the engine returns { gaps: [], intent:
 * { product_type: 'unsupported' } } — every rule short-circuits.
 *
 * `sidecar` is the bitmap sidecar; passing null still works but
 * disables any rule that needs blast-radius grounding.
 */
function runEngine({ store, sidecar = null, projectRoot, intent = null } = {}) {
  const activeIntent =
    intent ||
    (projectRoot ? loadIntent(projectRoot) : null) ||
    { product_type: 'unsupported', stack: [], notes: [] };

  const gaps = [];
  const ranBy = [];
  const skipped = [];
  const seen = new Set();

  for (const rule of rules) {
    if (!rule || typeof rule.run !== 'function') {
      skipped.push({ rule_id: rule && rule.id, reason: 'malformed_rule' });
      continue;
    }
    let applies = false;
    try {
      applies = typeof rule.appliesWhen === 'function' ? !!rule.appliesWhen(activeIntent) : true;
    } catch (err) {
      skipped.push({ rule_id: rule.id, reason: 'appliesWhen_threw:' + (err && err.message ? err.message : err) });
      continue;
    }
    if (!applies) {
      skipped.push({ rule_id: rule.id, reason: 'gated_by_intent' });
      continue;
    }

    const started = Date.now();
    let out = [];
    try {
      out = rule.run({ store, sidecar, intent: activeIntent }) || [];
      if (!Array.isArray(out)) out = [];
    } catch (err) {
      skipped.push({ rule_id: rule.id, reason: 'run_threw:' + (err && err.message ? err.message : err) });
      continue;
    }
    const ms = Date.now() - started;

    let kept = 0;
    for (const g of out) {
      const enriched = normalizeGap(g, rule);
      if (!enriched) continue;
      if (seen.has(enriched.gap_hash)) continue;
      seen.add(enriched.gap_hash);
      gaps.push(enriched);
      kept++;
    }
    ranBy.push({ rule_id: rule.id, count: kept, ms, applied: true });
  }

  // Rank: HIGH before MEDIUM before LOW; within a severity, more
  // recent detection first.
  const rank = { HIGH: 0, MEDIUM: 1, LOW: 2 };
  gaps.sort((a, b) => {
    const ra = rank[a.severity] != null ? rank[a.severity] : 3;
    const rb = rank[b.severity] != null ? rank[b.severity] : 3;
    if (ra !== rb) return ra - rb;
    return String(a.rule_id).localeCompare(String(b.rule_id));
  });

  return { gaps, ranBy, skipped, intent: activeIntent, ranAt: Date.now() };
}

/**
 * gapHash(rule_id, file, line) → 16-char sha1 prefix
 *
 * Exported so validate_diff and other callers can hash consistently.
 */
function gapHash(rule_id, file, line) {
  const key = `${rule_id || ''}|${file || ''}|${line == null ? '' : line}`;
  return crypto.createHash('sha1').update(key).digest('hex').slice(0, 16);
}

/**
 * normalizeGap(g, rule) → gap | null
 *
 * Enforces the Gap contract (rule_id, file, evidence, severity).
 * Fills in defaults from the rule module. Computes the stable
 * gap_hash. Returns null for gaps that don't meet the contract —
 * dropping malformed rows is safer than leaking untrusted data into
 * the audit log.
 */
function normalizeGap(g, rule) {
  if (!g || typeof g !== 'object') return null;
  const file = g.file ? String(g.file) : null;
  const evidence = g.evidence ? String(g.evidence).slice(0, 2000) : null;
  if (!file || !evidence) return null;
  const line = Number.isInteger(g.line) ? g.line : null;
  const severity = g.severity || rule.severity || 'LOW';
  const reversibility = g.reversibility || rule.reversibility || null;
  const concept = g.concept || rule.concept || null;
  return {
    rule_id: rule.id,
    file,
    line,
    severity,
    reversibility,
    concept,
    evidence,
    gap_hash: gapHash(rule.id, file, line),
  };
}

/**
 * loadedRules() → [rule, ...] (read-only view)
 *
 * Test helper. The registry is a plain array, but we return a copy so
 * tests can't accidentally mutate the shared list.
 */
function loadedRules() {
  return rules.slice();
}

module.exports = {
  runEngine,
  gapHash,
  normalizeGap,
  loadedRules,
};
