'use strict';

/**
 * Temporal queries — back the 8 temporal MCP tools.
 *
 * Each function takes an open TemporalStore plus optional time window and
 * returns a plain-object result the MCP server formats as markdown.
 *
 * Tools:
 *   1. getArchitecturalDrift(domain?, sinceMs)
 *   2. getDomainEvolution(domain, sinceMs)
 *   3. getHotspotFiles({ sinceMs, limit })
 *   4. getComplexityTrend(filePath, sinceMs)
 *   5. getChurnVsBlastRadius(sinceMs)
 *   6. getArchEvents({ severity, sinceMs, kind, limit })
 *   7. getDomainHealth(domain?)
 *   8. getTemporalContext(filePath)
 *
 * All queries fail soft: if the temporal DB is missing, return an empty
 * structured response. Callers (MCP server, CLI) decide how to render that.
 */

/**
 * parseTimeRange("7d" | "30d" | "24h" | "1y") → milliseconds | null
 */
function parseTimeRange(s) {
  if (typeof s !== 'string' || s.length === 0) return null;
  const m = s.trim().match(/^(\d+)\s*([smhdwy])?$/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n) || n < 0) return null;
  const unit = (m[2] || 'd').toLowerCase();
  const mult = unit === 's' ? 1000 :
               unit === 'm' ? 60_000 :
               unit === 'h' ? 3_600_000 :
               unit === 'd' ? 86_400_000 :
               unit === 'w' ? 604_800_000 :
               unit === 'y' ? 31_536_000_000 : null;
  if (mult === null) return null;
  return n * mult;
}

function sinceTsFromRange(range) {
  if (!range) return null;
  const ms = parseTimeRange(range);
  if (!ms) return null;
  return Date.now() - ms;
}

/**
 * getArchitecturalDrift(temporal, { domain, timeRange })
 *
 * Returns: { window, totals, byDomain, trend }
 *   - byDomain: [{ domain, snapshots, fileChange, eventCount }]
 *   - trend: 'growing' | 'stable' | 'shrinking' | 'unknown'
 */
function getArchitecturalDrift(temporal, { domain = null, timeRange = '30d' } = {}) {
  if (!temporal || !temporal.db) return emptyDriftResult();
  const sinceTs = sinceTsFromRange(timeRange);
  const snaps = sinceTs ? temporal.getSnapshotsBetween(sinceTs, Date.now()) : temporal.getSnapshotsBetween(0, Date.now());
  if (snaps.length < 2) return { ...emptyDriftResult(), window: timeRange, reason: 'insufficient_data' };

  const first = snaps[0];
  const last = snaps[snaps.length - 1];

  // Per-domain growth between first and last.
  const firstDomains = bucketByDomain(temporal.getFileDomainsAt(first.id));
  const lastDomains = bucketByDomain(temporal.getFileDomainsAt(last.id));
  const allDomains = new Set([...firstDomains.keys(), ...lastDomains.keys()]);

  const byDomain = [];
  for (const d of allDomains) {
    if (domain && d !== domain) continue;
    const before = (firstDomains.get(d) || new Set()).size;
    const after = (lastDomains.get(d) || new Set()).size;
    const eventCount = temporal.getArchEvents({ sinceTs }).filter(e => e.domain === d).length;
    byDomain.push({ domain: d, before, after, delta: after - before, eventCount });
  }
  byDomain.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  const totalBefore = byDomain.reduce((s, r) => s + r.before, 0);
  const totalAfter = byDomain.reduce((s, r) => s + r.after, 0);
  const trend = totalAfter > totalBefore * 1.05 ? 'growing'
              : totalAfter < totalBefore * 0.95 ? 'shrinking'
              : 'stable';

  return {
    window: timeRange,
    totals: { snapshots: snaps.length, fileCountBefore: totalBefore, fileCountAfter: totalAfter },
    byDomain,
    trend,
  };
}

function emptyDriftResult() {
  return { window: null, totals: { snapshots: 0, fileCountBefore: 0, fileCountAfter: 0 }, byDomain: [], trend: 'unknown' };
}

/**
 * getDomainEvolution(temporal, { domain, timeRange })
 *
 * Returns: { domain, points: [{ ts, fileCount }] }
 */
function getDomainEvolution(temporal, { domain, timeRange = '90d' } = {}) {
  if (!temporal || !temporal.db || !domain) return { domain, points: [] };
  const sinceTs = sinceTsFromRange(timeRange);
  const snaps = sinceTs ? temporal.getSnapshotsBetween(sinceTs, Date.now()) : temporal.getSnapshotsBetween(0, Date.now());
  const points = [];
  for (const s of snaps) {
    const buckets = bucketByDomain(temporal.getFileDomainsAt(s.id));
    const set = buckets.get(domain);
    const fileCount = set ? set.size : 0;
    points.push({ ts: s.ts, snapshot_id: s.id, fileCount });
  }
  return { domain, points };
}

/**
 * getHotspotFiles(temporal, { sinceTs?, limit? })
 *
 * "Hotspot" = commit_count * blast_radius (the classic CodeHealth heuristic
 * adapted for Carto). High-churn files in high-blast-radius positions are
 * where bugs cluster.
 *
 * Returns: { hotspots: [{ file_path, commit_count, blast_radius, score }] }
 */
function getHotspotFiles(temporal, { timeRange = '90d', limit = 20 } = {}) {
  if (!temporal || !temporal.db) return { hotspots: [], window: timeRange };
  const sinceTs = sinceTsFromRange(timeRange);
  const churn = temporal.getTopChurned(500, sinceTs);
  const scored = churn.map(c => ({
    file_path: c.file_path,
    commit_count: c.commit_count,
    blast_radius: c.blast_radius || 0,
    last_modified_ts: c.last_modified_ts,
    score: c.commit_count * Math.max(1, c.blast_radius || 0),
  }));
  scored.sort((a, b) => b.score - a.score);
  return { hotspots: scored.slice(0, limit), window: timeRange };
}

/**
 * getComplexityTrend(temporal, { file, timeRange })
 *
 * Returns: { file, points: [{ ts, blast_radius, snapshot_id }], trend }
 */
function getComplexityTrend(temporal, { file, timeRange = '90d' } = {}) {
  if (!temporal || !temporal.db || !file) return { file, points: [], trend: 'unknown' };
  const sinceTs = sinceTsFromRange(timeRange);
  // We don't currently snapshot per-file blast radius into a time series
  // (that would explode storage). We approximate by reading file_domains_at
  // for the file across snapshots — counts +1 per snapshot the file was
  // present, and reports the *current* blast_radius from file_churn.
  const rows = sinceTs
    ? temporal.db.prepare(`
        SELECT s.id as snapshot_id, s.ts FROM snapshots s
        JOIN file_domains_at fda ON fda.snapshot_id = s.id
        WHERE fda.file_path = ? AND s.ts >= ?
        ORDER BY s.ts ASC
      `).all(file, sinceTs)
    : temporal.db.prepare(`
        SELECT s.id as snapshot_id, s.ts FROM snapshots s
        JOIN file_domains_at fda ON fda.snapshot_id = s.id
        WHERE fda.file_path = ?
        ORDER BY s.ts ASC
      `).all(file);

  const churn = temporal.getFileChurn(file);
  const currentBR = churn ? (churn.blast_radius || 0) : 0;
  const points = rows.map(r => ({ ts: r.ts, snapshot_id: r.snapshot_id, blast_radius: currentBR }));

  return {
    file,
    points,
    snapshots_present: points.length,
    commit_count: churn ? churn.commit_count : 0,
    last_modified_ts: churn ? churn.last_modified_ts : null,
    trend: points.length >= 3 ? 'tracked' : 'sparse',
  };
}

/**
 * getChurnVsBlastRadius(temporal, { timeRange })
 *
 * Scatter data — every file in the temporal index with non-zero churn.
 * Returns: { files: [{ file_path, commit_count, blast_radius }] }
 */
function getChurnVsBlastRadius(temporal, { timeRange = '90d' } = {}) {
  if (!temporal || !temporal.db) return { files: [], window: timeRange };
  const sinceTs = sinceTsFromRange(timeRange);
  const rows = sinceTs
    ? temporal.db.prepare(`
        SELECT file_path, commit_count, blast_radius FROM file_churn
        WHERE last_modified_ts >= ? AND commit_count > 0
        ORDER BY commit_count DESC
        LIMIT 1000
      `).all(sinceTs)
    : temporal.db.prepare(`
        SELECT file_path, commit_count, blast_radius FROM file_churn
        WHERE commit_count > 0
        ORDER BY commit_count DESC
        LIMIT 1000
      `).all();
  return { files: rows, window: timeRange };
}

/**
 * getArchEvents(temporal, { severity, timeRange, kind, limit })
 */
function getArchEvents(temporal, { severity = null, timeRange = '90d', kind = null, limit = 100 } = {}) {
  if (!temporal || !temporal.db) return { events: [], window: timeRange };
  const sinceTs = sinceTsFromRange(timeRange);
  const events = temporal.getArchEvents({ severity, kind, sinceTs, limit });
  return { events, window: timeRange };
}

/**
 * getDomainHealth(temporal, { domain? })
 *
 * Returns: { domains: [{ domain, current_size, prior_size, growth_rate,
 *                         instability, hotspots, events }] }
 */
function getDomainHealth(temporal, { domain = null } = {}) {
  if (!temporal || !temporal.db) return { domains: [] };
  const recent = temporal.getMostRecentSnapshot();
  if (!recent) return { domains: [] };
  const current = bucketByDomain(temporal.getFileDomainsAt(recent.id));

  // Compare to a snapshot ~30 days ago.
  const cutoff = Date.now() - 30 * 86_400_000;
  const priorRow = temporal.db
    .prepare('SELECT * FROM snapshots WHERE ts <= ? ORDER BY ts DESC LIMIT 1')
    .get(cutoff);

  const prior = priorRow ? bucketByDomain(temporal.getFileDomainsAt(priorRow.id)) : new Map();

  const allDomains = new Set([...current.keys(), ...prior.keys()]);
  const result = [];

  for (const d of allDomains) {
    if (domain && d !== domain) continue;
    const c = current.get(d) || new Set();
    const p = prior.get(d) || new Set();
    const intersection = setIntersect(p, c);
    const moved = p.size - intersection.size;
    const growth = c.size - p.size;
    const events = temporal.getArchEvents({ sinceTs: cutoff }).filter(e => e.domain === d);

    // Score blast radii of files in this domain.
    const allChurn = temporal.getAllChurn();
    const churnMap = new Map(allChurn.map(r => [r.file_path, r]));
    const hotFiles = [];
    for (const fp of c) {
      const ch = churnMap.get(fp);
      if (ch && ch.commit_count >= 3 && ch.blast_radius >= 10) {
        hotFiles.push({
          file_path: fp,
          commit_count: ch.commit_count,
          blast_radius: ch.blast_radius,
        });
      }
    }
    hotFiles.sort((a, b) => (b.commit_count * b.blast_radius) - (a.commit_count * a.blast_radius));

    result.push({
      domain: d,
      current_size: c.size,
      prior_size: p.size,
      growth,
      growth_rate: p.size > 0 ? Math.round((growth / p.size) * 100) / 100 : null,
      instability: p.size > 0 ? Math.round((moved / p.size) * 100) / 100 : 0,
      hotspots: hotFiles.slice(0, 5),
      events: events.length,
    });
  }
  result.sort((a, b) => Math.abs(b.growth) - Math.abs(a.growth));
  return { domains: result };
}

/**
 * getTemporalContext(temporal, { file })
 *
 * Returns: {
 *   file, first_seen_ts, last_modified_ts, commit_count, blast_radius,
 *   recent_events: [{ ts, kind, severity, detail }],
 *   age_days: number,
 *   snapshots_present: number
 * }
 */
function getTemporalContext(temporal, { file } = {}) {
  if (!temporal || !temporal.db || !file) return { file, present: false };
  const churn = temporal.getFileChurn(file);
  if (!churn) return { file, present: false };

  const events = temporal.db
    .prepare('SELECT * FROM arch_events WHERE file_path = ? ORDER BY ts DESC LIMIT 10')
    .all(file);

  const snapshots = temporal.db
    .prepare('SELECT COUNT(*) as c FROM file_domains_at WHERE file_path = ?')
    .get(file);

  const ageDays = churn.first_seen_ts
    ? Math.round((Date.now() - churn.first_seen_ts) / 86_400_000)
    : null;

  return {
    file,
    present: true,
    first_seen_ts: churn.first_seen_ts,
    last_modified_ts: churn.last_modified_ts,
    commit_count: churn.commit_count,
    blast_radius: churn.blast_radius || 0,
    age_days: ageDays,
    snapshots_present: snapshots ? snapshots.c : 0,
    recent_events: events.map(e => ({
      ts: e.ts,
      kind: e.kind,
      severity: e.severity,
      detail: e.detail_json ? safeParse(e.detail_json) : null,
    })),
  };
}

// ── helpers ──────────────────────────────────────────────────────
function bucketByDomain(rows) {
  const m = new Map();
  for (const r of rows) {
    const d = r.domain_name;
    if (!d) continue;
    if (!m.has(d)) m.set(d, new Set());
    m.get(d).add(r.file_path);
  }
  return m;
}

function setIntersect(a, b) {
  const out = new Set();
  const [small, large] = a.size < b.size ? [a, b] : [b, a];
  for (const v of small) if (large.has(v)) out.add(v);
  return out;
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

module.exports = {
  getArchitecturalDrift,
  getDomainEvolution,
  getHotspotFiles,
  getComplexityTrend,
  getChurnVsBlastRadius,
  getArchEvents,
  getDomainHealth,
  getTemporalContext,
  parseTimeRange,
};
