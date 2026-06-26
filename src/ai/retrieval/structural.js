'use strict';

/**
 * Structural retrieval — wraps existing graph + change-plan queries.
 *
 * Each function returns a uniform shape: [{ file_id, path, score }] so
 * the RRF layer can fuse with lexical + semantic channels.
 */

const { planChange } = require('../../mcp/change-plan');

/**
 * structuralSearch(store, intent, { limit })
 *
 * Wraps `planChange` and returns the top files by structural relevance.
 * Score = the change-plan internal score (token+blast+route+similarity).
 * Returns [] if change-plan returns no candidates.
 */
function structuralSearch(store, intent, { limit = 30 } = {}) {
  if (!store || !intent) return [];
  try {
    const plan = planChange(store, intent);
    if (!plan || !plan.filesToTouch || plan.filesToTouch.length === 0) return [];
    return plan.filesToTouch.slice(0, limit).map(f => {
      const filePath = f.path || f;
      const file = store.getFileByPath(filePath);
      return {
        file_id: file ? file.id : null,
        path: filePath,
        score: f.score != null ? f.score : 1.0,
      };
    });
  } catch {
    return [];
  }
}

/**
 * neighborhoodSearch(store, file, { hops })
 *
 * Returns import-graph neighbors of `file` as ranked candidates.
 * Score = 1 / hop_distance — closer files rank higher.
 */
function neighborhoodSearch(store, file, { hops = 2 } = {}) {
  if (!store || !file) return [];
  try {
    const neighbors = store.getNeighbors(file, hops);
    if (!neighbors || !neighbors.nodes) return [];
    return neighbors.nodes
      .filter(n => n.file !== file)
      .map(n => ({
        file_id: null,
        path: n.file,
        score: 1 / Math.max(1, n.hop_distance || 1),
      }));
  } catch {
    return [];
  }
}

/**
 * domainSearch(store, domain, { limit })
 *
 * Returns all files in `domain`, sorted by centrality (high blast first).
 */
function domainSearch(store, domain, { limit = 50 } = {}) {
  if (!store || !store.db || !domain) return [];
  try {
    return store.db.prepare(`
      SELECT f.id as file_id, f.path as path, f.centrality as score
      FROM files f
      JOIN domains d ON f.domain_id = d.id
      WHERE d.name = ?
      ORDER BY f.centrality DESC
      LIMIT ?
    `).all(domain, limit);
  } catch {
    return [];
  }
}

module.exports = { structuralSearch, neighborhoodSearch, domainSearch };
