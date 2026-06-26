'use strict';

/**
 * Active Suggestion Engine.
 *
 * Four detectors:
 *   1. AUTH coupling jumped — a domain gained more than N cross-domain edges
 *      in the last week.
 *   2. AI session conflict — the same file was modified by two different
 *      sessions within a short window in the episodic log.
 *   3. Convention violation mid-session — a recent HIGH-severity intervention
 *      that the user hasn't accepted.
 *   4. Hotspot threshold crossed — commit_count × blast_radius is above a
 *      configurable score.
 *
 * MCP has a `notify` channel for server-pushed messages, but client support
 * is uneven, so for now the AI polls `getActiveSuggestions()`. The four
 * detectors run synchronously; a heartbeat that fires server-side
 * notifications can be added later without changing the detector code.
 */

const DEFAULT_THRESHOLDS = {
  cross_domain_jump: 3,           // edges added per domain over window
  session_conflict_window_ms: 30 * 60 * 1000,
  hotspot_score: 60,
  intervention_window_ms: 60 * 60 * 1000,
};

/**
 * loadThresholds(projectRoot) — read overrides from carto.config.json.
 */
function loadThresholds(projectRoot) {
  try {
    const fs = require('fs');
    const path = require('path');
    const cfgPath = path.join(projectRoot, 'carto.config.json');
    if (!fs.existsSync(cfgPath)) return { ...DEFAULT_THRESHOLDS };
    const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    const brain = raw && raw.brain ? raw.brain : {};
    return { ...DEFAULT_THRESHOLDS, ...brain };
  } catch {
    return { ...DEFAULT_THRESHOLDS };
  }
}

/**
 * getActiveSuggestions({ store, temporalStore, projectRoot }) → Array<suggestion>
 *
 * Each suggestion:
 *   { id, trigger, severity, summary, detail, ts }
 */
function getActiveSuggestions({ store, temporalStore, projectRoot }) {
  const t = loadThresholds(projectRoot);
  const suggestions = [];

  // ── Trigger 1: cross-domain coupling jump ───────────────────────
  if (temporalStore) {
    try {
      const q = require('../../temporal/queries');
      const drift = q.getArchitecturalDrift(temporalStore, { timeRange: '7d' });
      for (const d of (drift.byDomain || [])) {
        if (d.delta >= t.cross_domain_jump && d.before > 0) {
          suggestions.push({
            id: `coupling_${d.domain}`,
            trigger: 'cross_domain_jump',
            severity: 'major',
            summary: `${d.domain} grew by ${d.delta} files in the last 7d.`,
            detail: { domain: d.domain, before: d.before, after: d.after, delta: d.delta },
            ts: Date.now(),
          });
        }
      }
    } catch {}
  }

  // ── Trigger 2: AI session conflict ──────────────────────────────
  // Two distinct sessions touched the same file within the conflict window.
  if (store && store.db) {
    try {
      const since = Date.now() - t.session_conflict_window_ms;
      const rows = store.db.prepare(`
        SELECT file, COUNT(DISTINCT session_id) as sessions, MAX(ts) as ts
        FROM decisions
        WHERE ts >= ? AND file IS NOT NULL
        GROUP BY file
        HAVING sessions >= 2
        LIMIT 20
      `).all(since);
      for (const r of rows) {
        suggestions.push({
          id: `session_conflict_${r.file}`,
          trigger: 'session_conflict',
          severity: 'critical',
          summary: `${r.file} has been modified by ${r.sessions} AI sessions in the last 30 min.`,
          detail: { file: r.file, sessions: r.sessions, last_ts: r.ts },
          ts: r.ts,
        });
      }
    } catch {}
  }

  // ── Trigger 3: convention violation (recent unaccepted intervention) ─
  if (store && store.getInterventionsForFile) {
    try {
      const since = Date.now() - t.intervention_window_ms;
      const all = store.getInterventionsForFile(null) || [];
      const recent = all.filter(i =>
        i.ts >= since && !i.accepted && i.severity === 'HIGH'
      );
      for (const iv of recent.slice(0, 10)) {
        suggestions.push({
          id: `intervention_${iv.id}`,
          trigger: 'convention_violation',
          severity: 'major',
          summary: iv.message || `Unresolved HIGH-severity issue on ${iv.file || '—'}.`,
          detail: { intervention_id: iv.id, file: iv.file, kind: iv.kind },
          ts: iv.ts,
        });
      }
    } catch {}
  }

  // ── Trigger 4: hotspot threshold crossed ────────────────────────
  if (temporalStore) {
    try {
      const q = require('../../temporal/queries');
      const r = q.getHotspotFiles(temporalStore, { timeRange: '30d', limit: 50 });
      for (const h of (r.hotspots || [])) {
        if (h.score >= t.hotspot_score) {
          suggestions.push({
            id: `hotspot_${h.file_path}`,
            trigger: 'hotspot_active',
            severity: h.score >= t.hotspot_score * 2 ? 'critical' : 'major',
            summary: `${h.file_path} score ${h.score} (${h.commit_count} commits × blast ${h.blast_radius}).`,
            detail: { ...h },
            ts: h.last_modified_ts || Date.now(),
          });
        }
      }
    } catch {}
  }

  // Sort newest first; dedupe by id.
  suggestions.sort((a, b) => b.ts - a.ts);
  const seen = new Set();
  return suggestions.filter(s => {
    if (seen.has(s.id)) return false;
    seen.add(s.id);
    return true;
  }).slice(0, 50);
}

module.exports = { getActiveSuggestions, loadThresholds, DEFAULT_THRESHOLDS };
