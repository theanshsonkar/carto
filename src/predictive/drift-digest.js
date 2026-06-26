'use strict';

/**
 * Weekly drift digest renderer.
 *
 * Produces a CLI-renderable weekly architectural digest as markdown.
 * Slack delivery is left to whatever cron + webhook the user wires up;
 * this module only renders the body.
 *
 * Content:
 *   1. Domain growth/shrink over `time_range` (default 7d)
 *   2. Top hotspots (commit_count × blast_radius)
 *   3. New architectural events
 *   4. New cross-domain edges introduced
 *   5. Top files by predictive risk score
 */

function renderDriftDigest({ store, temporalStore, projectRoot, timeRange = '7d' }) {
  if (!store) return '# Drift Digest\n\n_No store available._';

  const lines = [`# Drift Digest (${timeRange})`];
  lines.push(`\nGenerated ${new Date().toISOString()}\n`);

  // ── Domain drift ────────────────────────────────────────────────
  if (temporalStore) {
    try {
      const q = require('../temporal/queries');
      const drift = q.getArchitecturalDrift(temporalStore, { timeRange });
      lines.push('## Domain drift');
      lines.push(`Trend: **${drift.trend}**.`);
      if (drift.byDomain && drift.byDomain.length > 0) {
        lines.push('| Domain | Before | After | Δ |');
        lines.push('|--------|-------:|------:|---|');
        for (const d of drift.byDomain.slice(0, 10)) {
          lines.push(`| ${d.domain} | ${d.before} | ${d.after} | ${d.delta > 0 ? '+' + d.delta : d.delta} |`);
        }
      }
    } catch {}

    // ── Hotspots ────────────────────────────────────────────────
    try {
      const q = require('../temporal/queries');
      const h = q.getHotspotFiles(temporalStore, { timeRange, limit: 10 });
      if (h.hotspots && h.hotspots.length > 0) {
        lines.push('\n## Top hotspots');
        lines.push('| File | Commits | Blast | Score |');
        lines.push('|------|--------:|------:|------:|');
        for (const x of h.hotspots) {
          lines.push(`| ${x.file_path} | ${x.commit_count} | ${x.blast_radius} | ${x.score} |`);
        }
      }
    } catch {}

    // ── Events ──────────────────────────────────────────────────
    try {
      const q = require('../temporal/queries');
      const e = q.getArchEvents(temporalStore, { timeRange, limit: 20 });
      if (e.events && e.events.length > 0) {
        lines.push('\n## Architectural events');
        lines.push('| When | Severity | Kind | Target |');
        lines.push('|------|----------|------|--------|');
        for (const ev of e.events) {
          const when = new Date(ev.ts).toISOString();
          const target = ev.domain || ev.file_path || '';
          lines.push(`| ${when} | ${ev.severity} | ${ev.kind} | ${target} |`);
        }
      }
    } catch {}
  } else {
    lines.push('## Temporal data unavailable\n\nRun `carto temporal init` to enable drift, hotspot, and events sections.');
  }

  // ── Predictive risk top 10 ────────────────────────────────
  try {
    const { scoreFiles } = require('./risk-score');
    const ranked = scoreFiles({ store, temporalStore, projectRoot }).slice(0, 10);
    if (ranked.length > 0) {
      lines.push('\n## Predicted-risk top 10');
      lines.push('| File | Score |');
      lines.push('|------|------:|');
      for (const f of ranked) lines.push(`| ${f.path} | ${f.score} |`);
    }
  } catch {}

  return lines.join('\n');
}

module.exports = { renderDriftDigest };
