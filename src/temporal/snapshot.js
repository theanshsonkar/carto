'use strict';

/**
 * captureSnapshot — write a temporal snapshot from the current sidecar.
 *
 * Called by `runSync()` after a successful sync (and by `carto temporal
 * init` for the initial state). Records:
 *   - snapshot row in `snapshots`
 *   - file→domain mapping in `file_domains_at`
 *   - file_churn `blast_radius` column refreshed
 *   - XOR delta vs the most recent prior sync snapshot (forward adjacency)
 *   - architectural events vs prior snapshot (domain split/merge, hotspot emergence)
 *
 * Cost budget: <100ms on a 10K-file repo. Hot loop is the file_domains_at
 * write (a single transaction over ~10K rows). The XOR delta is a single
 * gzip of a few KB of bits.
 */

const { TemporalStore } = require('./store');
const { xorBitsets, compressBitset, flattenMap } = require('./delta');
const { detectEvents } = require('./events');

/**
 * captureSnapshot({ projectRoot, sidecar, store, source, commitSha, ts })
 *
 * sidecar  — bitmap sidecar from buildFromStore()
 * store    — main SQLiteStore (for blast radius / centrality data)
 * source   — 'sync' | 'commit' | 'backfill'
 * commitSha — optional, for commit-source snapshots
 * ts       — optional, defaults to Date.now()
 *
 * Returns: { snapshotId, events: Array, eventCount: number }
 */
function captureSnapshot({ projectRoot, sidecar, store, source = 'sync', commitSha = null, ts = null }) {
  const temporal = new TemporalStore(projectRoot);
  temporal.open();
  try {
    return captureSnapshotWithStore({ temporal, sidecar, store, source, commitSha, ts });
  } finally {
    temporal.close();
  }
}

function captureSnapshotWithStore({ temporal, sidecar, store, source = 'sync', commitSha = null, ts = null }) {
  const tsNow = ts || Date.now();
  if (!sidecar) {
    // No bitmap — still record a metadata-only snapshot.
    const snapshotId = temporal.insertSnapshot({
      ts: tsNow, commit_sha: commitSha, source,
      summary: { file_count: 0, edge_count: 0, domain_count: 0 },
    });
    return { snapshotId, events: [], eventCount: 0 };
  }

  // ── 1. Compute summary stats ────────────────────────────────────
  const fileCount = sidecar.filePathArr ? sidecar.filePathArr.filter(Boolean).length : 0;
  let edgeCount = 0;
  if (sidecar.forward) {
    for (const bs of sidecar.forward.values()) edgeCount += bs.popcount();
  }
  const domainCount = sidecar.domainNameArr ? sidecar.domainNameArr.filter(Boolean).length : 0;

  // ── 2. Insert snapshot row ──────────────────────────────────────
  const snapshotId = temporal.insertSnapshot({
    ts: tsNow,
    commit_sha: commitSha,
    source,
    summary: { file_count: fileCount, edge_count: edgeCount, domain_count: domainCount },
  });

  // ── 3. Insert file→domain mapping ───────────────────────────────
  const mappings = [];
  for (let fid = 0; fid < (sidecar.size || 0); fid++) {
    const filePath = sidecar.filePathArr ? sidecar.filePathArr[fid] : null;
    if (!filePath) continue;
    const dId = sidecar.fileDomainArr ? sidecar.fileDomainArr[fid] : -1;
    const domainName = dId >= 0 && sidecar.domainNameArr ? sidecar.domainNameArr[dId] : null;
    mappings.push({ file_path: filePath, domain_name: domainName });
  }
  temporal.insertFileDomains(snapshotId, mappings);

  // ── 4. Refresh blast_radius per file ────────────────────────────
  if (sidecar.popcountIndex && sidecar.filePathArr) {
    const radiusMap = new Map();
    for (const { fileId, count } of sidecar.popcountIndex) {
      const p = sidecar.filePathArr[fileId];
      if (p) radiusMap.set(p, count);
    }
    temporal.updateBlastRadii(radiusMap);
  }

  // ── 5. XOR delta vs prior snapshot ──────────────────────────────
  const prior = findPriorSnapshot(temporal, snapshotId);
  if (prior) {
    try {
      const current = flattenMap(sidecar.forward || new Map(), sidecar.size || 0);
      const priorBits = priorFlatBitset(temporal, prior);
      if (priorBits) {
        const delta = xorBitsets(current, priorBits);
        const blob = compressBitset(delta);
        temporal.insertDelta(snapshotId, prior.id, 'forward_xor', blob, current.size);
      }
    } catch {
      // XOR delta is a nice-to-have. A failure here doesn't break temporal.
    }
  }

  // ── 6. Architectural event detection vs prior snapshot ──────────
  const events = detectEvents({ temporal, snapshotId, prior, mappings, sidecar, ts: tsNow });
  for (const e of events) {
    temporal.insertEvent({
      ts: e.ts || tsNow,
      severity: e.severity,
      kind: e.kind,
      domain: e.domain || null,
      file_path: e.file_path || null,
      detail: e.detail || null,
      snapshot_id: snapshotId,
    });
  }

  return { snapshotId, events, eventCount: events.length };
}

/**
 * Find the snapshot immediately prior to `snapshotId` (any source).
 * Used to compute XOR deltas and event detection.
 */
function findPriorSnapshot(temporal, snapshotId) {
  return temporal.db
    .prepare('SELECT * FROM snapshots WHERE id < ? ORDER BY id DESC LIMIT 1')
    .get(snapshotId);
}

/**
 * Reconstruct the prior flattened bitset by re-applying XOR deltas from
 * the most recent stored full-state snapshot.
 *
 * Today we don't store full reconstructable forward bitsets per snapshot
 * (that would defeat the XOR-delta compression). Returns null for now —
 * the XOR-delta is stored as a fact about "what changed between snapshot
 * N-1 and snapshot N", and queries iterate deltas to answer "what changed
 * in a time window?" without needing point-in-time graph reconstruction.
 *
 * Full point-in-time reconstruction is a Tier-2 follow-up.
 */
function priorFlatBitset(_temporal, _prior) {
  return null;
}

module.exports = { captureSnapshot, captureSnapshotWithStore };
