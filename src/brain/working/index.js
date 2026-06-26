'use strict';

/**
 * Working Memory — live state tracker.
 *
 * The "right now" view of the repo: what's in flight, what hasn't been
 * committed, what warnings are still open. Composed from existing data:
 *
 *   - git: uncommitted files, branch state
 *   - episodic memory (decisions, interventions): unresolved warnings
 *   - temporal store: recent drift
 *
 * Returns plain objects; no persistence of its own.
 */

const { execFileSync } = require('child_process');

/**
 * getUncommittedFiles(projectRoot) → Array<{ path, change_kind }>
 *
 * Uses `git status --porcelain` for cross-platform consistency.
 */
function getUncommittedFiles(projectRoot) {
  try {
    const out = execFileSync('git', ['-C', projectRoot, 'status', '--porcelain'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const files = [];
    for (const line of out.split('\n')) {
      if (line.length === 0) continue;
      const status = line.slice(0, 2);
      const filePath = line.slice(3).trim();
      let kind = 'modified';
      if (status.includes('A') || status.startsWith('??')) kind = 'added';
      else if (status.includes('D')) kind = 'deleted';
      else if (status.includes('R')) kind = 'renamed';
      files.push({ path: filePath, change_kind: kind });
    }
    return files;
  } catch {
    return [];
  }
}

/**
 * getWorkingMemory({ store, temporalStore, projectRoot }) → working memory snapshot
 *
 * Returns:
 *   {
 *     branch, head_sha,
 *     uncommitted_files: [{ path, change_kind }],
 *     recent_decisions_count, recent_interventions_count,
 *     open_warnings: [{ ts, file, severity, message }],
 *     recent_drift: { domain, trend, growth_rate } | null,
 *   }
 */
function getWorkingMemory({ store, temporalStore, projectRoot }) {
  const uncommitted = getUncommittedFiles(projectRoot);
  let branch = null, headSha = null;
  try {
    branch = execFileSync('git', ['-C', projectRoot, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {}
  try {
    headSha = execFileSync('git', ['-C', projectRoot, 'rev-parse', 'HEAD'], {
      encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim().slice(0, 12);
  } catch {}

  // Recent decisions + interventions (24h).
  let recentDecisions = 0, openWarnings = [];
  if (store && store.getRecentDecisions) {
    const day = 24 * 60 * 60 * 1000;
    recentDecisions = store.getRecentDecisions(day).length;
    const interventions = store.getInterventionsForFile(null);
    const cutoff = Date.now() - day;
    openWarnings = interventions
      .filter(i => i.ts >= cutoff && !i.accepted)
      .slice(0, 20)
      .map(i => ({
        ts: i.ts, file: i.file, severity: i.severity, kind: i.kind, message: i.message,
      }));
  }

  // Recent drift from temporal store.
  let recentDrift = null;
  if (temporalStore) {
    try {
      const q = require('../../temporal/queries');
      const r = q.getArchitecturalDrift(temporalStore, { timeRange: '7d' });
      if (r && r.byDomain && r.byDomain.length > 0) {
        const top = r.byDomain[0];
        recentDrift = {
          domain: top.domain,
          before: top.before,
          after: top.after,
          delta: top.delta,
          trend: r.trend,
        };
      }
    } catch {}
  }

  return {
    branch, head_sha: headSha,
    uncommitted_files: uncommitted,
    recent_decisions_count: recentDecisions,
    open_warnings: openWarnings,
    recent_drift: recentDrift,
  };
}

/**
 * getPendingDecisions(store, opts) → Array<decision>
 *
 * Returns decisions from the episodic memory log that look unresolved —
 * heuristic: a decision whose `payload_json` contains a `pending` or
 * `unresolved` flag, or any decision in the last 6 hours that has
 * interventions attached.
 */
function getPendingDecisions(store, { hours = 6 } = {}) {
  if (!store || !store.getRecentDecisions) return [];
  const window = hours * 60 * 60 * 1000;
  const decisions = store.getRecentDecisions(window);
  const out = [];
  for (const d of decisions) {
    let payload = null;
    try { payload = JSON.parse(d.payload_json || '{}'); } catch {}
    const looksPending = payload && (payload.pending === true || payload.unresolved === true ||
      (payload.risk && (payload.risk === 'HIGH' || payload.risk === 'MEDIUM')));
    if (looksPending) {
      out.push({
        id: d.id,
        session_id: d.session_id,
        ts: d.ts,
        kind: d.kind,
        file: d.file,
        payload,
      });
    }
  }
  return out;
}

/**
 * getActiveDrift(temporalStore, opts) → { domains: [...], threshold_breaches: [...] }
 */
function getActiveDrift(temporalStore, { threshold = 0.2 } = {}) {
  if (!temporalStore) return { domains: [], threshold_breaches: [] };
  try {
    const q = require('../../temporal/queries');
    const r = q.getArchitecturalDrift(temporalStore, { timeRange: '7d' });
    const breaches = (r.byDomain || []).filter(d => {
      if (d.before === 0) return false;
      return Math.abs(d.delta) / d.before >= threshold && Math.abs(d.delta) >= 3;
    });
    return { domains: r.byDomain || [], threshold_breaches: breaches };
  } catch {
    return { domains: [], threshold_breaches: [] };
  }
}

module.exports = {
  getWorkingMemory,
  getUncommittedFiles,
  getPendingDecisions,
  getActiveDrift,
};
