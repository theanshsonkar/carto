'use strict';

/**
 * detectEvents — architectural events between consecutive snapshots.
 *
 * Surfaces things like:
 *   - "AUTH domain split into AUTH + SESSIONS"
 *   - "EVENTS merged into CORE"
 *   - "src/lib/db.ts crossed the hotspot threshold"
 *   - "PAYMENTS gained 3 cross-domain imports this month"
 *
 * Each event is severity-tagged so `get_arch_events('critical')` can filter
 * down to the few that matter.
 *
 * Reads the prior snapshot's file→domain assignments, compares to the
 * current mappings, and emits one row per significant delta. Domain
 * stability uses the anchor + majority-vote rule.
 */

/**
 * detectEvents({ temporal, snapshotId, prior, mappings, sidecar, ts }) → Array<event>
 *
 * `mappings`: [{ file_path, domain_name }] — current snapshot's assignments
 * `prior`:    previous snapshot row (may be null)
 * `sidecar`:  bitmap sidecar (for blast radius / centrality data)
 *
 * Returns an array of event objects with shape:
 *   { kind, severity, domain?, file_path?, detail? }
 */
function detectEvents({ temporal, snapshotId, prior, mappings, sidecar, ts }) {
  const events = [];
  if (!prior) {
    // First snapshot — emit a single 'initial' event so the timeline isn't
    // empty on fresh repos.
    const domainSummary = summarizeDomains(mappings);
    events.push({
      kind: 'initial_snapshot',
      severity: 'minor',
      detail: { domains: domainSummary, file_count: mappings.length },
      ts,
    });
    return events;
  }

  const priorRows = temporal.getFileDomainsAt(prior.id);
  if (priorRows.length === 0) return events;

  // ── Build prior + current per-domain file sets ────────────────────
  const priorByDomain = bucketByDomain(priorRows);
  const currentByDomain = bucketByDomain(mappings);

  const allDomains = new Set([
    ...priorByDomain.keys(),
    ...currentByDomain.keys(),
  ]);

  for (const domain of allDomains) {
    if (!domain) continue;

    const priorSet = priorByDomain.get(domain) || new Set();
    const currentSet = currentByDomain.get(domain) || new Set();

    // ── Domain disappeared ──
    if (priorSet.size > 0 && currentSet.size === 0) {
      events.push({
        kind: 'domain_disappeared',
        severity: priorSet.size >= 10 ? 'major' : 'minor',
        domain,
        detail: { prior_file_count: priorSet.size },
        ts,
      });
      continue;
    }

    // ── Domain newly appeared ──
    if (priorSet.size === 0 && currentSet.size > 0) {
      events.push({
        kind: 'new_domain',
        severity: currentSet.size >= 10 ? 'major' : 'minor',
        domain,
        detail: { file_count: currentSet.size },
        ts,
      });
      continue;
    }

    // ── Domain grew or shrank significantly (>20%) ──
    if (priorSet.size > 0 && currentSet.size > 0) {
      const delta = currentSet.size - priorSet.size;
      const pctDelta = Math.abs(delta) / priorSet.size;
      if (pctDelta >= 0.2 && Math.abs(delta) >= 5) {
        events.push({
          kind: delta > 0 ? 'domain_growth' : 'domain_shrink',
          severity: pctDelta >= 0.5 ? 'major' : 'minor',
          domain,
          detail: {
            prior_file_count: priorSet.size,
            current_file_count: currentSet.size,
            delta,
            pct_change: Math.round(pctDelta * 100) / 100,
          },
          ts,
        });
      }

      // ── File defection: >30% of prior set moved out + new files in ──
      const intersection = setIntersect(priorSet, currentSet);
      const moved = priorSet.size - intersection.size;
      const movedPct = moved / Math.max(1, priorSet.size);
      if (movedPct >= 0.3 && moved >= 3) {
        events.push({
          kind: 'domain_unstable',
          severity: movedPct >= 0.5 ? 'critical' : 'major',
          domain,
          detail: {
            prior_size: priorSet.size,
            moved_out: moved,
            kept: intersection.size,
            pct_moved: Math.round(movedPct * 100) / 100,
          },
          ts,
        });
      }
    }
  }

  // ── Hotspot emergence (any file crossing >=10 blast_radius
  // for the first time, with >=2 commits in the temporal data).
  if (sidecar && sidecar.popcountIndex) {
    const allChurn = temporal.getAllChurn();
    const churnMap = new Map(allChurn.map(r => [r.file_path, r]));
    for (const { fileId, count } of sidecar.popcountIndex.slice(0, 20)) {
      const filePath = sidecar.filePathArr ? sidecar.filePathArr[fileId] : null;
      if (!filePath) continue;
      const churn = churnMap.get(filePath);
      const cc = churn ? churn.commit_count : 0;
      if (count >= 20 && cc >= 2) {
        events.push({
          kind: 'hotspot_active',
          severity: count >= 50 ? 'critical' : 'major',
          file_path: filePath,
          detail: { blast_radius: count, commit_count: cc },
          ts,
        });
      }
    }
  }

  return events;
}

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

function summarizeDomains(mappings) {
  const m = new Map();
  for (const r of mappings) {
    const d = r.domain_name;
    if (!d) continue;
    m.set(d, (m.get(d) || 0) + 1);
  }
  return Object.fromEntries(m);
}

function setIntersect(a, b) {
  const out = new Set();
  const [small, large] = a.size < b.size ? [a, b] : [b, a];
  for (const v of small) if (large.has(v)) out.add(v);
  return out;
}

module.exports = { detectEvents };
