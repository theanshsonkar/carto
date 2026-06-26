'use strict';

/**
 * Reciprocal Rank Fusion (RRF).
 *
 * Combines ranked lists from multiple retrieval channels into a single
 * ranked output. The classic formula is:
 *
 *     RRF_score(d) = Σ_channels 1 / (k + rank_channel(d))
 *
 * where `k` is a small constant (60 by convention). Documents present in
 * multiple channels accumulate score; documents only present in one
 * still contribute their reciprocal-rank.
 *
 * Optional score boosts:
 *   - same-domain bias
 *   - high-blast-radius bias
 *   - recent-changes bias (temporal store dependent)
 *   - test-coverage bias
 *
 * Boost factors are additive on top of the base RRF score.
 */

const K = 60;

/**
 * fuse(channels, opts) → ranked [{ path, score, components }]
 *
 * `channels`: { lexical: [...], structural: [...], semantic: [...] }
 *   where each list is [{ path, file_id?, score }] sorted by score DESC
 *   (best first).
 *
 * `opts`:
 *   boosts        — optional Map<path, number> — additive RRF-scale bias.
 *   limit         — max results (default 30).
 *
 * Returns: [{ path, score, components: { lexical, structural, semantic, boost } }]
 */
function fuse(channels, { boosts = null, limit = 30 } = {}) {
  const acc = new Map();

  for (const [channelName, list] of Object.entries(channels)) {
    if (!Array.isArray(list)) continue;
    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      if (!item || !item.path) continue;
      const rrf = 1 / (K + (i + 1));
      if (!acc.has(item.path)) {
        acc.set(item.path, { path: item.path, score: 0, components: {} });
      }
      const row = acc.get(item.path);
      row.score += rrf;
      row.components[channelName] = rrf;
    }
  }

  // Apply additive boosts.
  if (boosts && typeof boosts.forEach === 'function') {
    boosts.forEach((boost, path) => {
      if (acc.has(path)) {
        const row = acc.get(path);
        row.score += boost;
        row.components.boost = boost;
      }
    });
  }

  return Array.from(acc.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * computeBoosts(store, opts) → Map<path, number>
 *
 * Walks opts and emits per-path additive bias:
 *   sameDomain: domain name → boost
 *   highBlast:  multiplier on centrality (rough estimate)
 *   recent:     temporal hotspots (1 / churn_count)
 *
 * The default boost magnitudes are intentionally small (RRF-scale bumps
 * in the 0.01–0.1 range) so they nudge ordering rather than dominate it.
 */
function computeBoosts(store, { sameDomain = null, highBlast = false, recentChurn = null } = {}) {
  const boosts = new Map();
  if (!store || !store.db) return boosts;

  if (sameDomain) {
    try {
      const rows = store.db.prepare(`
        SELECT f.path FROM files f JOIN domains d ON f.domain_id = d.id WHERE d.name = ?
      `).all(sameDomain);
      for (const r of rows) boosts.set(r.path, (boosts.get(r.path) || 0) + 0.05);
    } catch {}
  }

  if (highBlast) {
    try {
      const rows = store.db.prepare(`
        SELECT path, centrality FROM files WHERE centrality > 0 ORDER BY centrality DESC LIMIT 50
      `).all();
      const max = rows[0] ? rows[0].centrality : 1;
      for (const r of rows) {
        boosts.set(r.path, (boosts.get(r.path) || 0) + (0.05 * (r.centrality / Math.max(1, max))));
      }
    } catch {}
  }

  if (recentChurn && Array.isArray(recentChurn)) {
    // recentChurn = [{ file_path, commit_count }, ...] from temporal store
    const max = recentChurn.reduce((m, r) => Math.max(m, r.commit_count || 0), 1);
    for (const r of recentChurn) {
      const norm = (r.commit_count || 0) / Math.max(1, max);
      boosts.set(r.file_path, (boosts.get(r.file_path) || 0) + 0.03 * norm);
    }
  }

  return boosts;
}

module.exports = { fuse, computeBoosts, K };
